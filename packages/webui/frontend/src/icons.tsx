import type { ReactNode, SVGProps } from 'react';

/**
 * Inline stroke-only SVG icons ported verbatim from the Claude Design handoff
 * (tools/design-spec/qanyicat/project/app.jsx). The whole set lives here so any
 * page can `import { I } from './icons'` and pluck what it needs without
 * pulling a 50KB icon library.
 */
function Icon({ d, children, ...rest }: { d?: string; children?: ReactNode } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {d ? <path d={d} /> : children}
    </svg>
  );
}

export const I = {
  dashboard: <Icon><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Icon>,
  network: <Icon><path d="M3 18h2M9 18h2M15 18h2M21 18h0" /><path d="M5 18V9M11 18V5M17 18V12" /></Icon>,
  log: <Icon><path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" /><path d="M14 4v4h4M8 13h7M8 17h5" /></Icon>,
  api: <Icon><path d="M3 12h3l2-7 4 14 2-7h3" /><circle cx="20" cy="12" r="1.5" /></Icon>,
  debug: <Icon><path d="M13 3 4 14h7l-1 7 9-11h-7z" /></Icon>,
  folder: <Icon><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Icon>,
  terminal: <Icon><path d="M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" /><path d="M8 10l3 2-3 2M13 14h4" /></Icon>,
  settings: <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Icon>,
  info: <Icon><circle cx="12" cy="12" r="9" /><path d="M12 8v.01M11 12h1v4h1" /></Icon>,
  sun: <Icon><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></Icon>,
  moon: <Icon d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  logout: <Icon><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></Icon>,
  menu: <Icon><path d="M3 6h18M3 12h12M3 18h18" /></Icon>,
  cpu: <Icon><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 9h6v6H9zM9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></Icon>,
  memory: <Icon><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 6v12M12 6v12M17 6v12" /></Icon>,
  chip: <Icon><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 4v-2M16 4v-2M8 22v-2M16 22v-2M4 8h-2M4 16h-2M22 8h-2M22 16h-2" /></Icon>,
  search: <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>,
  bell: <Icon><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0" /></Icon>,
  refresh: <Icon><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" /></Icon>,
  monitor: <Icon><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Icon>,
  github: <Icon><path d="M9 19c-4 1.5-4-2-6-2m12 4v-3.5a3 3 0 0 0-.8-2.2c2.8-.3 5.8-1.4 5.8-6.3a4.9 4.9 0 0 0-1.4-3.4 4.5 4.5 0 0 0-.1-3.4s-1.1-.3-3.5 1.3a12 12 0 0 0-6.3 0C6.3 2 5.2 2.4 5.2 2.4a4.5 4.5 0 0 0-.1 3.4A4.9 4.9 0 0 0 3.7 9c0 4.9 3 6 5.8 6.3A3 3 0 0 0 8.7 17.5V21" /></Icon>,
  plus: <Icon><path d="M12 5v14M5 12h14" /></Icon>,
  edit: <Icon><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></Icon>,
  trash: <Icon><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6" /></Icon>,
  bug: <Icon><rect x="8" y="6" width="8" height="14" rx="4" /><path d="M8 12H4M8 17H4M8 7l-2-3M16 12h4M16 17h4M16 7l2-3M12 6V3" /></Icon>,
  download: <Icon><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></Icon>,
  pause: <Icon><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></Icon>,
  play: <Icon d="M6 4l14 8-14 8z" />,
  clear: <Icon><path d="M3 6h18M8 12h13M14 18h7" /></Icon>,
  rocket: <Icon><path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.8-.8 1-2 .5-3a2 2 0 0 0-3 0z" /><path d="M14 14L5.5 5.5C8 3 13 2 16 2s4 3 4 4-1 6-3.5 8.5L8 14M12 6l2 2" /><circle cx="15" cy="9" r="1" /></Icon>,
  globe: <Icon><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Icon>,
  code: <Icon><path d="M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16" /></Icon>,
  puzzle: <Icon><path d="M14 4a2 2 0 1 1 4 0v2h3v3h-2a2 2 0 1 0 0 4h2v6h-6v-2a2 2 0 1 0-4 0v2H5v-6h2a2 2 0 1 0 0-4H5V6h6V4" /></Icon>,
  send: <Icon><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></Icon>,
  chat: <Icon><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9 8.5 8.5 0 0 1 8.5 8.5z" /></Icon>,
  doc: <Icon><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h6" /></Icon>,
  close: <Icon><path d="M18 6 6 18M6 6l12 12" /></Icon>,
  // v0.4n-housekeeping-4: semantic media-kind icons for FilesPage.
  image: <Icon><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m21 15-5-5L5 21" /></Icon>,
  video: <Icon><rect x="3" y="6" width="14" height="12" rx="2" /><path d="m17 10 5-3v10l-5-3" /></Icon>,
  voice: <Icon><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8" /></Icon>,
  file: <Icon><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></Icon>,
  link: <Icon><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></Icon>,
};
