/**
 * Fills a demo workspace with synthetic transactions from a CSV.
 *
 *   pnpm db:seed-demo                                    # ./Personal_Finance_Dataset.csv into demo-bank
 *   pnpm db:seed-demo -- --csv ~/data.zip --slug demo-bank
 *   pnpm db:seed-demo -- --no-shift --yes
 *
 * Written for the Kaggle "Personal Finance Data" set, whose columns are
 * `Date, Transaction Description, Category, Amount, Type`. Any CSV with those
 * five columns works; the ten category names below are the ones it ships.
 *
 * Only ever touches rows it minted itself — transaction ids are `demo_trans_...`,
 * derived from a hash of the CSV line — so re-running replaces its own data and
 * leaves anything else in the workspace alone. Accounts, the bank link and the
 * balances stay as they are: the balance chart walks *back* from today's balance
 * through these flows, which is what it does with real data too.
 *
 * ## What the CSV does not carry, and what is invented instead
 *
 * **Categories.** There is no "Food & Drink" in NZFCC, so each CSV category fans
 * out over a handful of real ones (`CATEGORIES`), chosen per row by hashing the
 * description so a re-run lands identically. The CSV's own category is not lost:
 * it goes on as a `Label`, which is what a household's own grouping is for, so
 * every row can still be traced back to the column it came from.
 *
 * **Direction.** The CSV's `Type` decides the sign — Expense out, Income in —
 * with one exception. It types every `Salary` row as an Expense, which is a
 * quirk of whatever generated it: the category names the direction, and 146 rows
 * of outgoing salary would leave the demo with no wages at all. Those rows are
 * read as income. `SALARY_IS_INCOME` turns that off.
 *
 * **Dates.** The set ends 2024-12-29. Left there, every "this month" view in the
 * app is empty and the demo shows nothing, so by default the whole series slides
 * forward as one block until its last row is yesterday — every interval between
 * transactions preserved, only the offset changed. `--no-shift` keeps the CSV's
 * dates.
 *
 * **Merchants** are not invented. The descriptions are the generator's word
 * salad and there is nothing to resolve them to; a null merchant is what an
 * unenriched transaction looks like anyway.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { mintId } from "../lib/ids";
import { authDb, catalogDb, scopedDb } from "../lib/server/db";

/** The id prefix that makes a row this script's to delete. */
const ID_PREFIX = "demo_trans_";

/** See the header: the CSV's `Salary`/Expense pairing read as income. */
const SALARY_IS_INCOME = true;

/**
 * CSV category to the NZFCC categories its rows spread over, by name. Names
 * rather than `nzfcc_...` ids: the ids are the catalog's, and a missing name is
 * a better error than a dangling id.
 */
const CATEGORIES: Record<string, string[]> = {
  Rent: ["Rent for permanent accommodation"],
  Utilities: [
    "Electricity services",
    "Gas services",
    "Internet services",
    "Telecommunication services",
    "Water and sanitation services",
  ],
  "Food & Drink": [
    "Supermarkets and grocery stores",
    "Cafes and restaurants",
    "Fast food stores",
    "Bakeries",
    "Liquor stores",
  ],
  "Health & Fitness": [
    "Gyms, fitness, aquatic facilities, yoga, pilates",
    "Doctors and physicians",
    "Pharmacies",
    "Dental services",
    "Physiotherapy and massage therapy",
  ],
  Shopping: [
    "Clothing stores",
    "General retail stores",
    "Electronic and appliance stores",
    "Shoe stores",
    "Home furnishing and repair stores",
  ],
  Entertainment: [
    "Cinemas",
    "Media and entertainment streaming services",
    "Digital gaming products and services",
    "Bars, pubs, nightclubs",
    "Attractions, museums, zoos, amusement parks, circuses, exhibits",
  ],
  Travel: [
    "Air transport services",
    "Hotels, motels, and other temporary accommodation",
    "Fuel stations",
    "Taxi, rideshare, and on-demand transport services",
    "Car and motorcycle rentals",
  ],
  Salary: ["Salary or wages"],
  Investment: ["Dividends", "Interest", "Investment withdrawals"],
  Other: [
    "Irregular income not elsewhere classified",
    "Merchant refunds or rebates",
    "Tax refunds or credits",
  ],
};

/**
 * CSV category to the accounts its rows land in, by account name, weighted by
 * repetition. Everyday money through the cheque account, discretionary spending
 * on the card, income into savings — enough for the account filters and the
 * per-account balance lines to have something to show.
 *
 * Resolved leniently (see `resolveAccounts`): a workspace whose accounts are
 * named differently still seeds, by type.
 */
const ACCOUNTS: Record<string, string[]> = {
  Salary: ["Checking Account"],
  Rent: ["Checking Account"],
  Utilities: ["Checking Account"],
  Investment: ["Savings Account"],
  Other: ["Savings Account"],
  "Health & Fitness": ["Checking Account", "Checking Account", "Credit Card"],
  Travel: ["Credit Card", "Credit Card", "Checking Account"],
  Shopping: ["Credit Card", "Credit Card", "Demo Overdrawn"],
  Entertainment: ["Credit Card"],
  "Food & Drink": ["Credit Card", "Credit Card", "Credit Card", "Demo Overdrawn"],
};

/** Account name to the `Account.type` to fall back to when no such name exists. */
const ACCOUNT_TYPES: Record<string, string> = {
  "Checking Account": "CHECKING",
  "Savings Account": "CHECKING",
  "Credit Card": "CREDITCARD",
  "Demo Overdrawn": "CHECKING",
};

type Row = {
  date: Date;
  description: string;
  csvCategory: string;
  /** Signed: negative out, positive in. */
  amount: number;
  id: string;
};

type Opts = { csv: string; slug: string; shift: boolean; yes: boolean };

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    csv: "Personal_Finance_Dataset.csv",
    slug: "demo-bank",
    shift: true,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm db:seed-demo -- --slug x` forwards the separator too.
    if (arg === "--") continue;
    else if (arg === "--csv") opts.csv = argv[++i];
    else if (arg === "--slug") opts.slug = argv[++i];
    else if (arg === "--no-shift") opts.shift = false;
    else if (arg === "-y" || arg === "--yes") opts.yes = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(
        [
          "Fill a demo workspace with synthetic transactions from a CSV.",
          "",
          "  --csv <path>   CSV, or a .zip holding one (default Personal_Finance_Dataset.csv)",
          "  --slug <slug>  workspace to fill (default demo-bank)",
          "  --no-shift     keep the CSV's own dates instead of sliding them up to today",
          "  -y, --yes      do not ask before replacing an earlier seed",
        ].join("\n"),
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** The CSV's text, unzipping first when handed an archive. */
function readCsv(path: string): string {
  if (!path.endsWith(".zip")) return readFileSync(path, "utf8");
  // `unzip -p` streams the single member out; the archives these sets ship in
  // hold exactly one CSV, and a second would be ambiguous anyway.
  return execFileSync("unzip", ["-p", path], { encoding: "utf8", maxBuffer: 64 << 20 });
}

/**
 * Enough CSV for this file: no embedded newlines, quotes only where a field
 * carries a comma. Anything richer belongs to a parser, not to a seed script.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

/** A stable number for a string, so every per-row choice survives a re-run. */
function digest(seed: string): number {
  return parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 12), 16);
}

function pick<T>(list: T[], seed: string): T {
  return list[digest(seed) % list.length];
}

function parseRows(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const need = ["Date", "Transaction Description", "Category", "Amount", "Type"];
  const missing = need.filter((h) => !header.includes(h));
  if (missing.length) {
    throw new Error(`CSV is missing column(s): ${missing.join(", ")}\n  got: ${header.join(", ")}`);
  }
  const at = Object.fromEntries(need.map((h) => [h, header.indexOf(h)]));

  return lines.slice(1).map((line, i) => {
    const field = splitCsvLine(line);
    const csvCategory = field[at.Category].trim();
    const magnitude = Math.abs(Number(field[at.Amount]));
    if (!Number.isFinite(magnitude)) {
      throw new Error(`row ${i + 2}: unreadable amount "${field[at.Amount]}"`);
    }
    // The CSV's amounts are unsigned; `Type` carries the direction, except for
    // the mistyped salary rows.
    const income =
      field[at.Type].trim() === "Income" || (SALARY_IS_INCOME && csvCategory === "Salary");
    return {
      date: new Date(`${field[at.Date].trim()}T00:00:00Z`),
      description: field[at["Transaction Description"]].trim(),
      csvCategory,
      amount: income ? magnitude : -magnitude,
      id: `${ID_PREFIX}${createHash("sha256").update(line).digest("hex").slice(0, 24)}`,
    };
  });
}

const DAY_MS = 86_400_000;

/** Whole days between the CSV's last date and yesterday, so the series ends live. */
function shiftDays(rows: Row[]): number {
  const last = Math.max(...rows.map((r) => r.date.getTime()));
  const now = new Date();
  const yesterday =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS;
  return Math.max(0, Math.round((yesterday - last) / DAY_MS));
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error("non-interactive: pass --yes to proceed");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/**
 * Account name to id, falling back to any account of the same type and then to
 * the first account at all, so the routing table never has to be edited to seed
 * a workspace whose accounts are named something else.
 */
function resolveAccounts(
  accounts: { id: string; name: string; type: string; connectionId: string }[],
): Map<string, { id: string; connectionId: string; label: string }> {
  const taken = new Set<string>();
  const routing = new Map<string, { id: string; connectionId: string; label: string }>();
  for (const wanted of Object.keys(ACCOUNT_TYPES)) {
    const found =
      accounts.find((a) => a.name === wanted) ??
      accounts.find((a) => a.type === ACCOUNT_TYPES[wanted] && !taken.has(a.id)) ??
      accounts[0];
    taken.add(found.id);
    routing.set(wanted, { id: found.id, connectionId: found.connectionId, label: found.name });
  }
  return routing;
}

/** `YYYY-MM-DD .. YYYY-MM-DD` across a set of rows. */
function span(rows: Row[]): string {
  const days = rows.map((r) => r.date.toISOString().slice(0, 10)).sort();
  return `${days[0]} .. ${days[days.length - 1]}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const rows = parseRows(readCsv(opts.csv));
  if (!rows.length) throw new Error(`${opts.csv} holds no data rows`);

  const unknown = [...new Set(rows.map((r) => r.csvCategory))].filter((c) => !CATEGORIES[c]);
  if (unknown.length) {
    throw new Error(
      `no NZFCC mapping for CSV categor${unknown.length > 1 ? "ies" : "y"}: ${unknown.join(", ")}\n` +
        "  add them to CATEGORIES and ACCOUNTS in this file",
    );
  }

  const workspace = await authDb.workspace.findUnique({
    where: { slug: opts.slug },
    select: { id: true, name: true },
  });
  if (!workspace) {
    throw new Error(
      `no workspace with slug "${opts.slug}". Create it first:\n` +
        `  money workspace create --name "Demo Bank" --slug ${opts.slug} --owner <email>`,
    );
  }

  const db = scopedDb(workspace.id);

  const accounts = await db.account.findMany({
    select: { id: true, name: true, type: true, connectionId: true },
    orderBy: { id: "asc" },
  });
  if (!accounts.length) {
    throw new Error(`workspace "${opts.slug}" has no accounts to hang transactions off`);
  }
  const routing = resolveAccounts(accounts);

  // The NZFCC catalog is instance-wide, so it is read unscoped like any other
  // reference lookup.
  const wanted = [...new Set(Object.values(CATEGORIES).flat())];
  const catalog = await catalogDb.category.findMany({
    where: { name: { in: wanted } },
    select: { id: true, name: true, groupId: true },
  });
  const byName = new Map(catalog.map((c) => [c.name, c]));
  const absent = wanted.filter((name) => !byName.has(name));
  if (absent.length) {
    throw new Error(
      `the NZFCC catalog in this database has no categor${absent.length > 1 ? "ies" : "y"} named:\n` +
        absent.map((name) => `  ${name}`).join("\n") +
        "\n  run a sync to mirror the catalog, or correct CATEGORIES in this file",
    );
  }

  const offset = opts.shift ? shiftDays(rows) : 0;
  const dated = rows.map((r) => ({ ...r, date: new Date(r.date.getTime() + offset * DAY_MS) }));

  const mine = await db.transaction.count({ where: { id: { startsWith: ID_PREFIX } } });
  const theirs = await db.transaction.count({ where: { NOT: { id: { startsWith: ID_PREFIX } } } });

  console.log();
  console.log(`  csv:        ${opts.csv} — ${rows.length} rows, ${span(rows)}`);
  console.log(`  workspace:  ${workspace.name} (/w/${opts.slug})`);
  console.log(
    `  dates:      ${offset ? `shifted +${offset} days, now ${span(dated)}` : "as in the CSV"}`,
  );
  console.log("  accounts:");
  for (const [name, account] of routing) {
    console.log(`    ${name.padEnd(18)} ${account.label}`);
  }
  if (theirs) console.log(`  keeping:    ${theirs} transaction(s) this script did not write`);
  if (mine) console.log(`  replacing:  ${mine} transaction(s) from an earlier seed`);
  console.log();

  if (mine && !opts.yes && !(await confirm("proceed? [y/N] "))) {
    console.log("aborted");
    return;
  }

  // Labels carry the CSV's own category through, one row per distinct value.
  // Reused rather than re-minted so a re-run does not orphan the old set.
  const labelIds = new Map<string, string>();
  for (const name of [...new Set(rows.map((r) => r.csvCategory))].sort()) {
    const label = await db.label.upsert({
      where: { workspaceId_name: { workspaceId: workspace.id, name } },
      create: { id: mintId("label"), workspaceId: workspace.id, name },
      update: {},
      select: { id: true },
    });
    labelIds.set(name, label.id);
  }

  const transactions = dated.map((row) => {
    const account = routing.get(pick(ACCOUNTS[row.csvCategory], `account:${row.description}`))!;
    const category = byName.get(pick(CATEGORIES[row.csvCategory], `category:${row.description}`))!;
    return {
      id: row.id,
      workspaceId: workspace.id,
      accountId: account.id,
      connectionId: account.connectionId,
      date: row.date,
      description: row.description,
      amount: row.amount,
      type: row.amount < 0 ? "DEBIT" : "CREDIT",
      categoryId: category.id,
      categoryGroupId: category.groupId,
      createdAt: row.date,
      updatedAt: row.date,
    };
  });

  const links = dated.map((row) => ({
    workspaceId: workspace.id,
    transactionId: row.id,
    labelId: labelIds.get(row.csvCategory)!,
  }));

  // One transaction: a half-seeded demo is worse than an unseeded one. The
  // labels themselves sit outside it — they are the workspace's, and are reused
  // by the next run either way.
  await db.$transaction(
    async (tx) => {
      await tx.transactionLabel.deleteMany({
        where: { transaction: { id: { startsWith: ID_PREFIX } } },
      });
      await tx.transaction.deleteMany({ where: { id: { startsWith: ID_PREFIX } } });
      await tx.transaction.createMany({ data: transactions });
      await tx.transactionLabel.createMany({ data: links });
    },
    { timeout: 120_000 },
  );

  const sum = (list: typeof transactions) => list.reduce((total, t) => total + t.amount, 0);
  const income = transactions.filter((t) => t.amount > 0);
  const spend = transactions.filter((t) => t.amount < 0);
  console.log(`==> ${transactions.length} transactions, ${labelIds.size} labels`);
  console.log(
    `    in ${income.length} (+${sum(income).toFixed(2)}), ` +
      `out ${spend.length} (${sum(spend).toFixed(2)}), ` +
      `net ${sum(transactions).toFixed(2)}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => authDb.$disconnect());
