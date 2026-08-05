import type { Metadata } from "next";
import { headers } from "next/headers";
import { InteractionFeedback } from "../components/InteractionFeedback";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "利明智耀 · 内容运营工作台",
    description: "面向新媒体团队的 AI 内容运营协作平台。",
    openGraph: { title: "利明智耀", description: "AI 内容运营协作平台", images: [image] },
    twitter: { card: "summary_large_image", title: "利明智耀", description: "AI 内容运营协作平台", images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}<InteractionFeedback /></body>
    </html>
  );
}
