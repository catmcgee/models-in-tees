const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export default async function handler(req: any, res: any): Promise<void> {
  const origin = process.env.TEE_API_ORIGIN || process.env.VITE_API_BASE_URL;
  if (!origin) {
    res.status(503).json({
      ok: false,
      error: "TEE_API_ORIGIN is not configured for this Vercel project."
    });
    return;
  }

  let upstream: URL;
  try {
    upstream = new URL(origin);
  } catch {
    res.status(500).json({ ok: false, error: "TEE_API_ORIGIN is not a valid URL." });
    return;
  }
  if (!["http:", "https:"].includes(upstream.protocol)) {
    res.status(500).json({ ok: false, error: "TEE_API_ORIGIN must use HTTP or HTTPS." });
    return;
  }

  const path = Array.isArray(req.query.path)
    ? req.query.path.join("/")
    : String(req.query.path || "");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "path") continue;
    if (Array.isArray(value)) {
      value.forEach((item) => query.append(key, String(item)));
    } else if (value !== undefined) {
      query.set(key, String(value));
    }
  }

  upstream.pathname = `/api/${path}`;
  upstream.search = query.toString();

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (hopByHopHeaders.has(key.toLowerCase()) || value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }

  const body = ["GET", "HEAD"].includes(req.method)
    ? undefined
    : ((await readBody(req)) as unknown as BodyInit);

  const response = await fetch(upstream, {
    method: req.method,
    headers,
    body
  });

  res.status(response.status);
  for (const [key, value] of response.headers.entries()) {
    if (!hopByHopHeaders.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  }
  res.send(Buffer.from(await response.arrayBuffer()));
}

async function readBody(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
