import { cors } from 'hono/cors';

export const corsMiddleware = cors({
  origin: [
    'https://blessblissmari.github.io',
    'https://bratan-corp.github.io',
    'http://localhost:5173',
    'http://localhost:3000',
  ],
  allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Range', 'X-Admin-Secret'],
  exposeHeaders: [
    'Content-Length',
    'Content-Type',
    'Content-Range',
    'Accept-Ranges',
    'ETag',
    'Last-Modified',
    'Cache-Control',
  ],
  maxAge: 86400,
  credentials: true,
});
