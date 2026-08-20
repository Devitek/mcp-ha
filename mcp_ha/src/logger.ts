// Logs sur stderr (visibles dans le journal de l'add-on) et audit structuré.

function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info(msg: string): void {
    console.error(`[${ts()}] INFO ${msg}`);
  },
  warn(msg: string): void {
    console.error(`[${ts()}] WARN ${msg}`);
  },
  error(msg: string): void {
    console.error(`[${ts()}] ERROR ${msg}`);
  },
};

/**
 * Journal d'audit des écritures : une ligne JSON par tentative, acceptée ou
 * refusée. Ne jamais y mettre de secret.
 */
export function audit(entry: Record<string, unknown>): void {
  console.error(JSON.stringify({ ts: ts(), audit: true, ...entry }));
}
