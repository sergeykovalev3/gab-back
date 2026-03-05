import { Router, Request, Response } from 'express';

/** Разрешённый хост для прокси (только MAX file storage). */
const ALLOWED_FILE_HOST = 'fd.oneme.ru';

/** Максимальный размер файла при прокси (20 МБ). */
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * Прокси для скачивания файлов с корректным Content-Disposition.
 *
 * GET /api/files/download?url=...&filename=...
 *
 * Безопасность:
 * - Разрешён только хост fd.oneme.ru (защита от SSRF)
 * - Ограничение размера 20 МБ
 *
 * Производительность:
 * - Стриминг: не буферизуем файл целиком в память
 */
export class FilesRoutes {
  public Router: Router;

  constructor() {
    this.Router = Router();
    this._initRoutes();
  }

  private _initRoutes(): void {
    this.Router.get('/download', this._handleDownload.bind(this));
  }

  private _handleDownload = async (req: Request, res: Response): Promise<void> => {
    const rawUrl = req.query.url;
    const filename = req.query.filename;

    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      res.status(400).json({ error: 'missing_url', message: 'Параметр url обязателен' });
      return;
    }

    let sourceUrl: URL;
    try {
      sourceUrl = new URL(rawUrl.trim());
    } catch {
      res.status(400).json({ error: 'invalid_url', message: 'Некорректный URL' });
      return;
    }

    if (sourceUrl.hostname !== ALLOWED_FILE_HOST) {
      res.status(403).json({
        error: 'forbidden_host',
        message: `Разрешён только хост ${ALLOWED_FILE_HOST}`,
      });
      return;
    }

    const safeFilename =
      typeof filename === 'string' && filename.trim()
        ? filename.trim().replace(/[^\w\s\u0400-\u04FF.-]/gi, '_').slice(0, 200)
        : 'download';
    const asciiFallback = (safeFilename.replace(/[^\x20-\x7E]/g, '_') || 'download').replace(
      /"/g,
      '\\"'
    );

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const upstream = await fetch(sourceUrl.toString(), {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'gab-backend-file-proxy/1.0' },
      });
      clearTimeout(timeout);

      if (!upstream.ok) {
        res.status(upstream.status).json({
          error: 'upstream_error',
          message: `Ошибка при загрузке файла: ${upstream.status}`,
        });
        return;
      }

      const contentLength = upstream.headers.get('content-length');
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (!Number.isNaN(size) && size > MAX_FILE_SIZE_BYTES) {
          res.status(413).json({
            error: 'file_too_large',
            message: `Файл превышает ${MAX_FILE_SIZE_BYTES / 1024 / 1024} МБ`,
          });
          return;
        }
      }

      const contentType =
        upstream.headers.get('content-type') ?? 'application/octet-stream';

      res.setHeader('Content-Type', contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
      );

      const body = upstream.body;
      if (!body) {
        res.status(502).json({ error: 'no_body', message: 'Тело ответа пустое' });
        return;
      }

      let totalBytes = 0;
      const reader = body.getReader();

      const pump = async (): Promise<void> => {
        const { value, done } = await reader.read();
        if (done) return;
        if (value && value.length > 0) {
          totalBytes += value.length;
          if (totalBytes > MAX_FILE_SIZE_BYTES) {
            reader.cancel();
            res.destroy();
            return;
          }
          res.write(Buffer.from(value));
        }
        return pump();
      };

      await pump();
      res.end();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        res.status(504).json({ error: 'timeout', message: 'Таймаут загрузки' });
        return;
      }
      console.error('[files] proxy error:', err);
      res.status(502).json({ error: 'proxy_error', message: 'Ошибка прокси' });
    }
  };
}
