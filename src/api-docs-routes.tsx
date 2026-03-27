import { Hono } from 'hono';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

const apiDocs = new Hono();

// Serve OpenAPI spec as JSON
apiDocs.get('/openapi.json', (c) => {
  try {
    const dir = typeof import.meta.dir === 'string' ? import.meta.dir : dirname(new URL(import.meta.url).pathname);
    const spec = readFileSync(join(dir, 'openapi-spec.json'), 'utf-8');
    c.header('Content-Type', 'application/json');
    return c.body(spec);
  } catch (error) {
    return c.json({ error: 'OpenAPI spec not found' }, 500);
  }
});

// Serve Swagger UI (CDN-based, zero npm dependencies)
apiDocs.get('/', (c) => {
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <title>ПРОМО.МУЗЫКА — API Documentation</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎵</text></svg>" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.18.2/swagger-ui.css" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0f0f23; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui { max-width: 1280px; margin: 0 auto; padding: 0 20px; }
    .api-header {
      max-width: 1280px; margin: 0 auto; padding: 24px 20px 16px;
      display: flex; align-items: center; gap: 16px;
      border-bottom: 1px solid #2a2a4a;
    }
    .api-header h1 {
      color: #e0e0ff; font-size: 24px; font-weight: 700;
    }
    .api-header .badge {
      background: #6c5ce7; color: #fff; padding: 4px 12px;
      border-radius: 12px; font-size: 12px; font-weight: 600;
    }
    .api-header .sub {
      color: #8888aa; font-size: 14px; margin-left: auto;
    }
    /* Dark theme overrides */
    .swagger-ui .opblock .opblock-summary-description { color: #b0b0cc; }
    .swagger-ui .info .title { color: #e0e0ff; }
    .swagger-ui .info p, .swagger-ui .info li { color: #b0b0cc; }
    .swagger-ui .scheme-container { background: #1a1a2e; border-bottom: 1px solid #2a2a4a; }
    .swagger-ui section.models { border: 1px solid #2a2a4a; }
    .swagger-ui .model-container { background: #1a1a2e; }
    .swagger-ui .opblock-tag { color: #c0c0e0; border-bottom-color: #2a2a4a; }
    .swagger-ui .opblock-tag:hover { color: #e0e0ff; }
    .swagger-ui .opblock { border-color: #2a2a4a; background: #1a1a2e; }
    .swagger-ui .opblock .opblock-summary { border-color: #2a2a4a; }
    .swagger-ui .opblock.opblock-get { background: rgba(97,175,254,.08); border-color: rgba(97,175,254,.3); }
    .swagger-ui .opblock.opblock-post { background: rgba(73,204,144,.08); border-color: rgba(73,204,144,.3); }
    .swagger-ui .opblock.opblock-put { background: rgba(252,161,48,.08); border-color: rgba(252,161,48,.3); }
    .swagger-ui .opblock.opblock-delete { background: rgba(249,62,62,.08); border-color: rgba(249,62,62,.3); }
    .swagger-ui .opblock.opblock-patch { background: rgba(80,227,194,.08); border-color: rgba(80,227,194,.3); }
    .swagger-ui .btn { border-color: #4a4a6a; color: #c0c0e0; }
    .swagger-ui .btn:hover { color: #fff; }
    .swagger-ui select { background: #1a1a2e; color: #c0c0e0; border-color: #4a4a6a; }
    .swagger-ui input[type=text] { background: #1a1a2e; color: #c0c0e0; border-color: #4a4a6a; }
    .swagger-ui textarea { background: #1a1a2e; color: #c0c0e0; border-color: #4a4a6a; }
    .swagger-ui .parameters-col_description input { background: #1a1a2e; color: #c0c0e0; }
    .swagger-ui table thead tr td, .swagger-ui table thead tr th { color: #b0b0cc; border-bottom-color: #2a2a4a; }
    .swagger-ui .parameter__name { color: #c0c0e0; }
    .swagger-ui .parameter__type { color: #8888aa; }
    .swagger-ui .response-col_status { color: #c0c0e0; }
    .swagger-ui .response-col_description { color: #b0b0cc; }
    .swagger-ui .responses-inner h4, .swagger-ui .responses-inner h5 { color: #c0c0e0; }
    .swagger-ui .opblock-description-wrapper p { color: #b0b0cc; }
    .swagger-ui .opblock-body pre.microlight { background: #0a0a1a; color: #c0c0e0; border: 1px solid #2a2a4a; }
    .swagger-ui .model-title { color: #c0c0e0; }
    .swagger-ui .model { color: #b0b0cc; }
    .swagger-ui .auth-wrapper .authorize { border-color: #6c5ce7; color: #6c5ce7; }
    .swagger-ui .auth-wrapper .authorize:hover { background: rgba(108,92,231,.1); }
    .swagger-ui .dialog-ux .modal-ux { background: #1a1a2e; border: 1px solid #2a2a4a; }
    .swagger-ui .dialog-ux .modal-ux-header h3 { color: #e0e0ff; }
    .swagger-ui .dialog-ux .modal-ux-content p { color: #b0b0cc; }
  </style>
</head>
<body>
  <div class="api-header">
    <h1>ПРОМО.МУЗЫКА API</h1>
    <span class="badge">v3.0.0</span>
    <span class="sub">promo-music.ru</span>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.18.2/swagger-ui-bundle.js"></script>
  <script>
    window.onload = function() {
      SwaggerUIBundle({
        url: '/server/api/docs/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIBundle.SwaggerUIStandalonePreset
        ],
        plugins: [SwaggerUIBundle.plugins.DownloadUrl],
        layout: 'BaseLayout',
        defaultModelsExpandDepth: 0,
        docExpansion: 'list',
        filter: true,
        tryItOutEnabled: false,
        persistAuthorization: true,
      });
    };
  </script>
</body>
</html>`;
  return c.html(html);
});

export default apiDocs;
