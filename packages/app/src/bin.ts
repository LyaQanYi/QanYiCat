import { main } from './index';

main(process.argv.slice(2)).catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
