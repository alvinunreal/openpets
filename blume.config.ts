import { defineConfig } from "blume";

const desktopMarkdownRedirects = [
  "/agent-integrations",
  "/catalog",
  "/development",
  "/i18n",
  "/ipc",
  "/pets",
  "/plugins",
  "/sdk",
].flatMap((targetRoute) => {
  const slug = targetRoute.slice(1);
  return [
    { from: `/desktop/${slug}.md`, to: targetRoute },
    { from: `/desktop/${slug}.mdx`, to: targetRoute },
  ];
});

export default defineConfig({
  title: "OpenPets Docs",
  description:
    "Documentation for OpenPets, the open-source desktop companion platform with pets, plugins, SDK v3, and local coding-agent integrations.",
  logo: {
    image: {
      alt: "OpenPets paw badge",
      dark: "/openpets-logo.png",
      light: "/openpets-logo.png",
    },
    text: "OpenPets Docs",
    href: "/",
  },
  content: {
    root: "docs",
    exclude: ["README.md", "**/_*", "**/.*"],
  },
  deployment: {
    output: "static",
    site: "https://docs.openpets.dev",
  },
  github: {
    owner: "alvinunreal",
    repo: "openpets",
    branch: "main",
  },
  navigation: {
    featured: [
      { label: "Download OpenPets", href: "https://openpets.dev", icon: "rocket" },
      { label: "GitHub", href: "https://github.com/alvinunreal/openpets", icon: "github" },
    ],
    sidebar: [
      "/",
      "/quickstart",
      "/install",
      {
        label: "Use OpenPets",
        items: ["/desktop", "/pets", "/official-plugins", "/agent-integrations", "/troubleshooting"],
      },
      {
        label: "Build",
        items: ["/sdk", "/plugins", "/cli", "/mcp", "/pet-format"],
      },
      {
        label: "Reference",
        items: ["/ipc", "/catalog", "/i18n"],
      },
      {
        label: "Maintainers",
        items: ["/architecture", "/development", "/testing-and-validation", "/release", "/lan-mode", "/wayland"],
      },
    ],
  },
  redirects: [
    ...desktopMarkdownRedirects,
    { from: "/plugin-sdk", to: "/sdk" },
    { from: "/developer", to: "/development" },
    { from: "/concepts", to: "/architecture" },
    { from: "/desktop-app", to: "/desktop" },
    { from: "/ai-assistants", to: "/agent-integrations" },
    { from: "/packages", to: "/development" },
    { from: "/files-and-config", to: "/desktop" },
    { from: "/superplugins", to: "/official-plugins" },
    { from: "/license", to: "https://github.com/alvinunreal/openpets/blob/main/LICENSE" },
  ],
  search: {
    provider: "orama",
  },
  markdown: {
    code: {
      icons: true,
      wrap: false,
    },
  },
  ai: {
    llmsTxt: true,
  },
  seo: {
    og: {
      enabled: true,
      logo: "/openpets-logo.svg",
      palette: {
        accent: "#22d3ee",
        background: "#f8fafc",
        border: "#cbd5e1",
        foreground: "#0f172a",
        muted: "#475569",
      },
    },
    sitemap: true,
    robots: true,
    structuredData: true,
  },
});
