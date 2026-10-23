import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repositoryRoot = dirname(dirname(__dirname));

const compat = new FlatCompat({
  baseDirectory: repositoryRoot,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".next/**", ".next-installer/**", "out/**", "build/**", "next-env.d.ts", "installer/**", "tools/**"],
  },
];

export default eslintConfig;
