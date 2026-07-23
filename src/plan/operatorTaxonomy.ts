/**
 * Classifies a raw PART_NAME (from EXA_*_PROFILE_* / $EXA_PROFILE_DETAILS_LAST_DAY)
 * into an OperatorType with fixed traits.
 *
 * Exasol's profile views are not documented as an exhaustive, stable enum of
 * PART_NAME literals — verified real profile output includes names at two
 * different granularities for the same logical operator (e.g. plain "JOIN"
 * from EXA_USER_PROFILE_LAST_DAY vs "PIPE JOIN" from
 * $EXA_PROFILE_DETAILS_LAST_DAY, or "GROUP BY" vs "PIPE AGGREGATOR" +
 * "GROUPBY POSTPROCESSING" + "GROUPBY INSERT"). Rather than an exact-match
 * enum that breaks the moment an unseen variant appears, classification is
 * substring-based with a conservative OTHER fallback — new/unrecognized part
 * names degrade gracefully instead of throwing or being silently mis-rendered
 * as something they're not.
 */
import { OperatorTraits, OperatorType } from './planModel';

const TRAITS_BY_TYPE: Record<OperatorType, OperatorTraits> = {
    SCAN: {
        producesRows: true, consumesRows: false, canSpill: false,
        movesDataOverNetwork: false, blocking: false, isSystemStep: false
    },
    JOIN: {
        producesRows: true, consumesRows: true, canSpill: true,
        movesDataOverNetwork: true, blocking: true, isSystemStep: false
    },
    GROUP_BY: {
        producesRows: true, consumesRows: true, canSpill: true,
        movesDataOverNetwork: true, blocking: true, isSystemStep: false
    },
    SORT: {
        producesRows: true, consumesRows: true, canSpill: true,
        movesDataOverNetwork: false, blocking: true, isSystemStep: false
    },
    NETWORK: {
        producesRows: true, consumesRows: true, canSpill: false,
        movesDataOverNetwork: true, blocking: false, isSystemStep: false
    },
    DML: {
        producesRows: false, consumesRows: true, canSpill: false,
        movesDataOverNetwork: false, blocking: false, isSystemStep: false
    },
    SYSTEM: {
        producesRows: false, consumesRows: false, canSpill: false,
        movesDataOverNetwork: false, blocking: false, isSystemStep: true
    },
    // Conservative default for anything unrecognized: treated as an
    // ordinary pass-through pipeline step, since we have no basis to
    // claim it can spill or move data over the network.
    OTHER: {
        producesRows: true, consumesRows: true, canSpill: false,
        movesDataOverNetwork: false, blocking: false, isSystemStep: false
    }
};

const TYPE_RULES: Array<{ type: OperatorType; test: (name: string) => boolean }> = [
    { type: 'SCAN', test: n => n.includes('SCAN') },
    { type: 'JOIN', test: n => n.includes('JOIN') },
    { type: 'GROUP_BY', test: n => n.includes('GROUP') || n.includes('AGGREGAT') },
    { type: 'SORT', test: n => n.includes('SORT') || n.includes('ORDER BY') },
    {
        type: 'NETWORK',
        // Not observed verbatim in a live profile trace during Step 0 research —
        // included defensively for redistribution-style parts. Falls back to
        // OTHER (never fabricated data) if the real string differs.
        test: n => n.includes('NETWORK') || n.includes('DISTRIBUT') || n.includes('BROADCAST') || n.includes('REORGANIZE')
    },
    {
        type: 'DML',
        test: n => ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'EXPORT', 'IMPORT'].some(k => n.includes(k))
    },
    {
        type: 'SYSTEM',
        test: n => [
            'COMPILE', 'EXECUTE', 'COMMIT', 'ROLLBACK', 'ALTER SESSION',
            'COLUMN STATISTICS', 'INDEX CREATE', 'TRANSACTION'
        ].some(k => n.includes(k))
    }
];

export interface OperatorClassification {
    operatorType: OperatorType;
    traits: OperatorTraits;
}

export function classifyOperator(partName: string): OperatorClassification {
    const normalized = (partName || '').toUpperCase();
    const rule = TYPE_RULES.find(r => r.test(normalized));
    const operatorType = rule?.type ?? 'OTHER';
    return { operatorType, traits: TRAITS_BY_TYPE[operatorType] };
}
