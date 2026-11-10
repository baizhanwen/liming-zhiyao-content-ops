import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // vinext also parses multipart API requests through its action handler.
    // Leave room for multipart framing; the upload API retains its 50 MiB cap.
    serverActions: { bodySizeLimit: "51mb" },
  },
};

export default nextConfig;
