export function privateR2Response(object: R2ObjectBody, request: Request) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  const partial = request.headers.has("range") && Boolean(object.range);
  if (partial && object.range) {
    const suffix = "suffix" in object.range ? Math.min(object.range.suffix ?? object.size, object.size) : null;
    const offset = suffix === null && "offset" in object.range ? object.range.offset ?? 0 : object.size - (suffix ?? object.size);
    const length = suffix ?? ("length" in object.range ? object.range.length ?? object.size - offset : object.size - offset);
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
  } else {
    headers.set("content-length", String(object.size));
  }
  return new Response(object.body, { status: partial ? 206 : 200, headers });
}
