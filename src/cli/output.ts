/**
 * Output helpers for CLI commands: ANSI-free tables and pretty JSON.
 */

export type Column<T> = {
  header: string;
  get: (row: T) => string | number | boolean | null | undefined;
  max?: number;
};

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + '…';
}

export function printTable<T>(rows: T[], columns: Column<T>[]): void {
  if (rows.length === 0) {
    console.log('(no results)');
    return;
  }

  const cells = rows.map((row) =>
    columns.map((col) => {
      const raw = col.get(row);
      const s = raw === null || raw === undefined ? '' : String(raw);
      return col.max ? truncate(s, col.max) : s;
    }),
  );

  const widths = columns.map((col, i) => {
    const headerLen = col.header.length;
    const maxData = cells.reduce((m, r) => Math.max(m, r[i].length), 0);
    return Math.max(headerLen, maxData);
  });

  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  const header = columns.map((c, i) => c.header.padEnd(widths[i])).join('  ');
  console.log(header);
  console.log(separator);
  for (const row of cells) {
    console.log(row.map((c, i) => c.padEnd(widths[i])).join('  '));
  }
}

export function renderOutput<T>(rows: T[], columns: Column<T>[], json: boolean): void {
  if (json) {
    printJson(rows);
  } else {
    printTable(rows, columns);
  }
}

export function renderSingle(value: unknown, json: boolean, formatter?: () => void): void {
  if (json) {
    printJson(value);
  } else if (formatter) {
    formatter();
  } else {
    console.log(value);
  }
}
