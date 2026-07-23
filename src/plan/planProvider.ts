/**
 * Fetches profile rows for a completed statement and normalizes them into a
 * Plan. This is the only module that knows Exasol's profile *table names* and
 * privilege model — profileRowNormalizer.ts knows the column shapes, this
 * file knows which view to query and in what fallback order.
 *
 * Fallback order, richest first (mirrors the attempt/fallback convention
 * already used by src/providers/objectTreeFetchers.ts):
 *   1. $EXA_PROFILE_DETAILS_LAST_DAY — per-node (IPROC) detail, requires the
 *      SELECT ANY DICTIONARY privilege. It is an internal/undocumented object,
 *      so this fallback chain protects v1 from that object disappearing or
 *      being renamed in a future Exasol version.
 *   2. EXA_DBA_PROFILE_LAST_DAY — cluster-wide aggregate, any session, same
 *      privilege requirement as #1.
 *   3. EXA_USER_PROFILE_LAST_DAY — cluster-wide aggregate, own sessions only,
 *      no special privilege. Always tried last so v1 always produces a plan
 *      (without per-node stats) for an unprivileged user profiling their own
 *      query.
 *
 * Identifying the right statement is harder than "STMT_ID equals X": Exasol
 * has no "give me the id of the statement that just ran" primitive.
 * CURRENT_STATEMENT returns the id of the statement asking the question, and
 * every statement (including that one) gets an implicit COMMIT/ROLLBACK
 * immediately after it, consuming another id. queryExecutor.ts captures a
 * *baseline* CURRENT_STATEMENT reading before the real query runs; this
 * module then searches forward from that baseline for the first statement
 * that isn't transaction bookkeeping — verified against a live instance to
 * reliably land on the real query regardless of how many implicit
 * COMMIT/ROLLBACK statements land in between (see afterStmtId below).
 *
 * A completed statement's profiling data is also not immediately visible
 * from a different connection than the one that ran it — measured on a live
 * instance at ~8-9 seconds before it appeared on its own. An explicit
 * FLUSH STATISTICS (from any connection, not necessarily the one that ran
 * the query) forces it to become visible in well under a second, so getPlan()
 * always issues one before attempting the fetch, with only a short retry
 * budget afterward as a safety margin rather than a multi-second poll.
 */
import { ConnectionManager, StoredConnection, BACKGROUND_QUERY_TIMEOUT_MS } from '../connectionManager';
import { getRowsFromResult, rawExecute, rawQuery } from '../utils';
import { getOutputChannel } from '../extension';
import { Plan } from './planModel';
import { normalizeProfileRows, ProfileSource } from './profileRowNormalizer';
import { WarningThresholds, DEFAULT_WARNING_THRESHOLDS } from './planWarnings';

export interface PlanTarget {
    /**
     * Exact digit strings, not `number` — Exasol's SESSION_ID (DECIMAL(20,0))
     * routinely exceeds Number.MAX_SAFE_INTEGER, and converting it to a JS
	 * number silently rounds it. Validated as a plain
     * digit string in getPlan() below before being interpolated into SQL.
     */
    sessionId: string;
    /**
     * CURRENT_STATEMENT read *before* the real query ran (see file header).
     * Not the real query's own STMT_ID — the fetch below searches forward
     * from this baseline for the first non-transaction statement.
     */
    afterStmtId: string;
}

interface FetchAttempt {
    source: ProfileSource;
    table: string;
    /** Only $EXA_PROFILE_DETAILS_LAST_DAY has an IPROC (per-node) column.
     * Ordering by it on the aggregate views fails because they do not expose it. */
    hasIproc: boolean;
}

const DIGITS_ONLY = /^\d+$/;

// Safety-margin pauses between full fallback-chain passes (not per-tier).
//
// Two schedules, chosen by whether the best-effort FLUSH STATISTICS succeeded:
//
//   * FLUSH succeeded — profiling data is forced visible in well under a
//     second, so a short window only covers the odd under-load straggler.
//     (~1.5s total.)
//
//   * FLUSH failed (e.g. the user lacks the flush privilege but can still read
//     the profile views) — the data only becomes visible from this background
//     session after Exasol's own cross-connection propagation, measured at
//     ~8-9s on a live instance (see file header). A 1.5s window here reported a
//     false "no profiling data found" for a user who would have seen the plan a
//     few seconds later, so this schedule polls out to comfortably past that
//     window (~13.5s total) before giving up.
//
// A genuine "no data" error only surfaces after the chosen schedule is
// exhausted. The privilege-denied-on-every-tier case never waits through
// either schedule: it throws on the first round (see getPlan()).
export const RETRY_DELAYS_MS = [0, 500, 1000];
export const RETRY_DELAYS_AFTER_FLUSH_FAILURE_MS = [0, 1000, 2000, 3000, 3500, 4000];

export interface PlanProviderRetryOptions {
    /** Overrides the post-flush-success retry schedule (testing seam). */
    retryDelaysMs?: number[];
    /** Overrides the post-flush-failure retry schedule (testing seam). */
    retryDelaysAfterFlushFailureMs?: number[];
}

const ATTEMPTS: FetchAttempt[] = [
    { source: 'DETAILS', table: '"$EXA_PROFILE_DETAILS_LAST_DAY"', hasIproc: true },
    { source: 'DBA_SUMMARY', table: 'EXA_DBA_PROFILE_LAST_DAY', hasIproc: false },
    { source: 'USER_SUMMARY', table: 'EXA_USER_PROFILE_LAST_DAY', hasIproc: false }
];

/**
 * Finds the STMT_ID of the first non-transaction statement after the given
 * baseline, then returns every row for that exact statement — a single
 * round trip via a correlated subquery, not two separate queries.
 */
function buildSql(attempt: FetchAttempt, target: PlanTarget): string {
    const { table } = attempt;
    const scope = `SESSION_ID = ${target.sessionId}`;
    const orderBy = attempt.hasIproc ? 'ORDER BY PART_ID, IPROC' : 'ORDER BY PART_ID';
    return `
        SELECT * FROM ${table}
        WHERE ${scope} AND STMT_ID = (
            SELECT MIN(STMT_ID) FROM ${table}
            WHERE ${scope} AND STMT_ID > ${target.afterStmtId} AND COMMAND_NAME NOT IN ('COMMIT', 'ROLLBACK')
        )
        ${orderBy}
    `;
}

/**
 * An insufficient-privilege response — the expected case for a non-DBA user
 * hitting tiers 1/2. Distinguished from isObjectNotFoundError below because
 * "every tier denied by privilege" gets its own, more accurate error message
 * (see getPlan()) instead of the generic "no profiling data" one.
 */
function isPrivilegeError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error ?? '')).toUpperCase();
    return message.includes('INSUFFICIENT PRIVILEGE');
}

/** Defends against a future Exasol version renaming/removing the
 * undocumented detail table — falls back rather than failing outright. */
function isObjectNotFoundError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error ?? '')).toUpperCase();
    return message.includes('NOT FOUND') && message.includes('OBJECT');
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class PlanProvider {
    private readonly retryDelaysMs: number[];
    private readonly retryDelaysAfterFlushFailureMs: number[];

    constructor(private connectionManager: ConnectionManager, retryOptions: PlanProviderRetryOptions = {}) {
        this.retryDelaysMs = retryOptions.retryDelaysMs ?? RETRY_DELAYS_MS;
        this.retryDelaysAfterFlushFailureMs =
            retryOptions.retryDelaysAfterFlushFailureMs ?? RETRY_DELAYS_AFTER_FLUSH_FAILURE_MS;
    }

    async getPlan(
        connection: StoredConnection,
        target: PlanTarget,
        thresholds: WarningThresholds = DEFAULT_WARNING_THRESHOLDS
    ): Promise<Plan> {
        if (!DIGITS_ONLY.test(target.sessionId) || !DIGITS_ONLY.test(target.afterStmtId)) {
            throw new Error('getPlan requires sessionId/afterStmtId to be plain digit strings');
        }

        const outputChannel = getOutputChannel();

        // Best-effort: force pending profiling data to become queryable now
        // rather than waiting out Exasol's natural flush interval. A failure
        // here (e.g. insufficient privilege in some deployments) just means
        // falling back to the retry loop's own margin below.
        let flushSucceeded = false;
        try {
            await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');
                const flushResult = await rawExecute(driver, 'FLUSH STATISTICS');
                // rawExecute() requests responseType: 'raw', and the driver only
                // throws on a SQL-level error (e.g. insufficient privilege) for its
                // default response type — 'raw' responses are handed back as-is,
                // error status included, with no throw. getRowsFromResult() is what
                // actually inspects that status and throws; FLUSH STATISTICS has no
                // rows to return on success, so this only ever surfaces a genuine
                // failure, never a false one.
                getRowsFromResult(flushResult);
            }, connection.id, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });
            flushSucceeded = true;
        } catch (error) {
            outputChannel?.appendLine(`   FLUSH STATISTICS before plan fetch failed (continuing anyway): ${error}`);
        }

        // With a successful flush the data is visible almost immediately; without
        // one we must poll long enough to outlast Exasol's cross-connection
        // propagation delay (see RETRY_DELAYS_AFTER_FLUSH_FAILURE_MS).
        const retryDelays = flushSucceeded ? this.retryDelaysMs : this.retryDelaysAfterFlushFailureMs;

        let lastError: unknown;

        for (let round = 0; round < retryDelays.length; round++) {
            if (retryDelays[round] > 0) {
                await sleep(retryDelays[round]);
            }

            const plan = await this.connectionManager.executeWithRetry(async () => {
                const driver = await this.connectionManager.getDriver(connection.id, 'background');

                // True only if every tier this round was denied specifically by
                // privilege — as opposed to reaching a tier and finding it empty,
                // which just means "not ready yet" and is worth retrying. If every
                // tier is a hard permission wall, no amount of retrying will help,
                // so getPlan() fails fast with a distinct, accurate message below
                // instead of the generic "no profiling data" one.
                let allDeniedByPrivilege = true;

                for (const attempt of ATTEMPTS) {
                    try {
                        const result = await rawQuery(driver, buildSql(attempt, target));
                        const rows = getRowsFromResult(result);
                        if (rows.length === 0) {
                            // Reached this tier — not a privilege wall. Not
                            // necessarily a privilege problem either — just no
                            // data yet (or the query hasn't propagated there at
                            // all). Keep going down the fallback chain.
                            allDeniedByPrivilege = false;
                            outputChannel?.appendLine(
                                `   Plan fetch (${attempt.source}): 0 rows for session ${target.sessionId} after stmt ${target.afterStmtId}`
                            );
                            continue;
                        }
                        const resolvedStmtId = String(rows[0].STMT_ID);
                        outputChannel?.appendLine(`   Plan fetch (${attempt.source}): ${rows.length} rows for resolved stmt ${resolvedStmtId}`);
                        return normalizeProfileRows(
                            rows,
                            { sessionId: target.sessionId, stmtId: resolvedStmtId, source: attempt.source },
                            thresholds
                        );
                    } catch (error) {
                        lastError = error;
                        if (isPrivilegeError(error)) {
                            outputChannel?.appendLine(`   Plan fetch (${attempt.source}) denied by privilege, falling back: ${error}`);
                            continue;
                        }
                        if (isObjectNotFoundError(error)) {
                            allDeniedByPrivilege = false;
                            outputChannel?.appendLine(`   Plan fetch (${attempt.source}) unavailable, falling back: ${error}`);
                            continue;
                        }
                        throw error;
                    }
                }

                if (allDeniedByPrivilege) {
                    throw new Error(
                        `Your database user doesn't have permission to view query profiling data — access was denied ` +
                        `on every available profile view. Ask a DBA to grant SELECT on EXA_USER_PROFILE_LAST_DAY ` +
                        `(available to all users by default in a standard Exasol setup), or SELECT ANY DICTIONARY for full per-node detail.`
                    );
                }
                return null;
            }, connection.id, { timeoutMs: BACKGROUND_QUERY_TIMEOUT_MS, role: 'background' });

            if (plan) {
                return plan;
            }
        }

        throw new Error(
            `No profiling data found for session ${target.sessionId} after statement ${target.afterStmtId}. ` +
            `Make sure execution plans are enabled, reconnect so session profiling is configured, ` +
            `then run the query again.` +
            (lastError ? ` Last error: ${lastError}` : '')
        );
    }
}
