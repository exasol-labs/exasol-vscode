import * as assert from 'assert';
import { classifyOperator } from '../../plan/operatorTaxonomy';

suite('classifyOperator', () => {

    suite('coarse PART_NAME values (EXA_USER_PROFILE_LAST_DAY / EXA_DBA_PROFILE_LAST_DAY)', () => {
        test('SCAN classifies as SCAN with produces-only traits', () => {
            const { operatorType, traits } = classifyOperator('SCAN');
            assert.strictEqual(operatorType, 'SCAN');
            assert.strictEqual(traits.producesRows, true);
            assert.strictEqual(traits.consumesRows, false);
            assert.strictEqual(traits.isSystemStep, false);
        });

        test('JOIN classifies as JOIN and can spill', () => {
            const { operatorType, traits } = classifyOperator('JOIN');
            assert.strictEqual(operatorType, 'JOIN');
            assert.strictEqual(traits.canSpill, true);
            assert.strictEqual(traits.movesDataOverNetwork, true);
        });

        test('GROUP BY classifies as GROUP_BY', () => {
            assert.strictEqual(classifyOperator('GROUP BY').operatorType, 'GROUP_BY');
        });

        test('SORT classifies as SORT and is blocking', () => {
            const { operatorType, traits } = classifyOperator('SORT');
            assert.strictEqual(operatorType, 'SORT');
            assert.strictEqual(traits.blocking, true);
        });

        test('COMPILE / EXECUTE classifies as SYSTEM, not a data-flow operator', () => {
            const { operatorType, traits } = classifyOperator('COMPILE / EXECUTE');
            assert.strictEqual(operatorType, 'SYSTEM');
            assert.strictEqual(traits.isSystemStep, true);
            assert.strictEqual(traits.producesRows, false);
        });

        test('COLUMN STATISTICS classifies as SYSTEM', () => {
            assert.strictEqual(classifyOperator('COLUMN STATISTICS').operatorType, 'SYSTEM');
        });

        test('INDEX CREATE classifies as SYSTEM', () => {
            assert.strictEqual(classifyOperator('INDEX CREATE').operatorType, 'SYSTEM');
        });

        test('COMMIT classifies as SYSTEM', () => {
            assert.strictEqual(classifyOperator('COMMIT').operatorType, 'SYSTEM');
        });

        test('INSERT classifies as DML', () => {
            assert.strictEqual(classifyOperator('INSERT').operatorType, 'DML');
        });

        test('IMPORT classifies as DML', () => {
            // Now load-bearing, not just defensive: the Plan tab is offered
            // for any statement with a captured session/statement id,
            // IMPORT/EXPORT included (see resultsPanel.ts), so a real IMPORT
            // plan's operators need to classify correctly too.
            assert.strictEqual(classifyOperator('IMPORT').operatorType, 'DML');
        });

        test('EXPORT classifies as DML', () => {
            assert.strictEqual(classifyOperator('EXPORT').operatorType, 'DML');
        });

        test('UPDATE classifies as DML', () => {
            assert.strictEqual(classifyOperator('UPDATE').operatorType, 'DML');
        });

        test('DELETE classifies as DML', () => {
            assert.strictEqual(classifyOperator('DELETE').operatorType, 'DML');
        });

        test('MERGE classifies as DML', () => {
            assert.strictEqual(classifyOperator('MERGE').operatorType, 'DML');
        });

        test('SYSTEM TABLE classifies as SCAN, not SYSTEM or OTHER (finding 14)', () => {
            // Live census: 11.7% of profile rows were SYSTEM TABLE parts,
            // all landing in OTHER before this rule existed. It reads a
            // system catalog object and produces rows exactly like any
            // other scan — the word SYSTEM in its name is not bookkeeping.
            const { operatorType, traits } = classifyOperator('SYSTEM TABLE');
            assert.strictEqual(operatorType, 'SCAN');
            assert.strictEqual(traits.producesRows, true);
            assert.strictEqual(traits.isSystemStep, false);
        });

        test('REPLICATE classifies as NETWORK (finding 14)', () => {
            assert.strictEqual(classifyOperator('REPLICATE').operatorType, 'NETWORK');
        });

        test('NODE SYNC classifies as SYNC — blocking, but deliberately not a system step (finding 14)', () => {
            // Real query time (frequently the single hottest node on a real
            // plan), not execution-engine bookkeeping — it must stay inside
            // the F2 user/data-flow cost-share denominator rather than
            // vanishing into the system-step total the way COMPILE/EXECUTE do.
            const { operatorType, traits } = classifyOperator('NODE SYNC');
            assert.strictEqual(operatorType, 'SYNC');
            assert.strictEqual(traits.blocking, true);
            assert.strictEqual(traits.isSystemStep, false);
            assert.strictEqual(traits.producesRows, false);
            assert.strictEqual(traits.consumesRows, false);
        });
    });

    suite('finer PART_NAME values ($EXA_PROFILE_DETAILS_LAST_DAY)', () => {
        test('PIPE SCAN classifies as SCAN', () => {
            assert.strictEqual(classifyOperator('PIPE SCAN').operatorType, 'SCAN');
        });

        test('PIPE JOIN classifies as JOIN', () => {
            assert.strictEqual(classifyOperator('PIPE JOIN').operatorType, 'JOIN');
        });

        test('PIPE AGGREGATOR classifies as GROUP_BY', () => {
            assert.strictEqual(classifyOperator('PIPE AGGREGATOR').operatorType, 'GROUP_BY');
        });

        test('GROUPBY POSTPROCESSING classifies as GROUP_BY', () => {
            assert.strictEqual(classifyOperator('GROUPBY POSTPROCESSING').operatorType, 'GROUP_BY');
        });

        test('GROUPBY INSERT classifies as GROUP_BY, not DML', () => {
            // Must be checked before the DML/INSERT rule to avoid misclassification.
            assert.strictEqual(classifyOperator('GROUPBY INSERT').operatorType, 'GROUP_BY');
        });

        test('COMPILE alone classifies as SYSTEM', () => {
            assert.strictEqual(classifyOperator('COMPILE').operatorType, 'SYSTEM');
        });

        test('EXECUTE alone classifies as SYSTEM', () => {
            assert.strictEqual(classifyOperator('EXECUTE').operatorType, 'SYSTEM');
        });
    });

    suite('unrecognized part names', () => {
        test('an unknown part name falls back to OTHER with conservative pass-through traits', () => {
            const { operatorType, traits } = classifyOperator('SOME_FUTURE_OPERATOR');
            assert.strictEqual(operatorType, 'OTHER');
            assert.strictEqual(traits.canSpill, false);
            assert.strictEqual(traits.movesDataOverNetwork, false);
            assert.strictEqual(traits.producesRows, true);
            assert.strictEqual(traits.consumesRows, true);
        });

        test('empty string does not throw and falls back to OTHER', () => {
            assert.strictEqual(classifyOperator('').operatorType, 'OTHER');
        });
    });

    suite('case insensitivity', () => {
        test('lowercase part name still classifies correctly', () => {
            assert.strictEqual(classifyOperator('scan').operatorType, 'SCAN');
        });
    });
});
