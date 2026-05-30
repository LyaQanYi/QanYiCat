import type { SdkMessage } from '../types/index.js';
import { plainText } from './matcher.js';

export interface ParsedCommand {
  name: string;
  args: string[];
}

export function parseCommand(msg: SdkMessage, prefix = '/'): ParsedCommand | null {
  const text = plainText(msg);
  if (!text.startsWith(prefix)) return null;
  const [name, ...args] = text.slice(prefix.length).split(/\s+/);
  if (!name) return null;
  return { name, args };
}
