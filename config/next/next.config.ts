import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build autocontido (server.js + só as dependências usadas), base do instalador Windows (installer/).
  output: "standalone",
  // O build do instalador usa outra pasta para não disputar o .next com um `next dev` rodando.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
