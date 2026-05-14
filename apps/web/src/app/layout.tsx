import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Harkness Helper — Episcopal High School",
  description:
    "Audio capture and transcription for Harkness discussions at Episcopal High School.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
