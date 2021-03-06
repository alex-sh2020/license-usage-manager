// ================================================================================
// Copyright (c) 2019-2020 AT&T Intellectual Property. All rights reserved.
// ================================================================================
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ============LICENSE_END=========================================================

const utils = require('../utils');
const pgclient = require('./pgclient');
const snapshot = require('./snapshot');
const SqlParams = require('./sql-params');
const odrl = require('./odrl');
const lumErrors = require('../error');

// const agreementKey = {"assetUsageAgreementId": true};
// {required: true, type: "array", ref: "swCategory"};
const assetUsageAgreementRecord = {
    "agreement": true,
    "agreementRestriction": true,
    "groomedAgreement": true
};

const assetUsageAgreementHouse = {
    "assetUsageAgreementRevision" : false,
    "assetUsageAgreementActive"   : false,
    "creator"           : false,
    "created"           : false,
    "modifier"          : false,
    "modified"          : false,
    "closer"            : false,
    "closed"            : false,
    "closureReason"     : false
};
const rightToUseFields = {
    "assetUsageRuleType" : true,
    "actions"            : false,
    "targetRefinement"   : false,
    "assigneeRefinement" : false,
    "usageConstraints"   : false,
    "consumedConstraints": false,
    "isPerpetual"        : false,
    "enableOn"           : false,
    "expireOn"           : false,
    "rightToUseActive"   : true,
    "closer"             : true,
    "closed"             : true,
    "closureReason"      : true
};
// const constraintKeys = {
//     "constraintScope": true,
//     "leftOperand"    : true,
//     "operator"       : true
// };
// const constraintDb = {
//     "rightOperand"   : true,
//     "dataType"       : true,
//     "unit"           : true
// };

/**
 * store rightToUse to the table in database
 * @param  {} res
 * @param  {} rightToUse single permission or prohibition
 */
async function storeRightToUse(res, rightToUse) {
    if (!res.locals.groomedAgreement || !rightToUse) {
        lumServer.logger.debug(res, `skipped storeRightToUse(${rightToUse.uid})`);
        return;
    }
    lumServer.logger.debug(res, `in storeRightToUse(${rightToUse.uid})`);

    const keys = new SqlParams();
    keys.addField("softwareLicensorId", res.locals.params.softwareLicensorId);
    keys.addField("assetUsageAgreementId", res.locals.params.assetUsageAgreementId);
    keys.addField("rightToUseId", rightToUse.uid);
    const putFields = new SqlParams(keys);
    putFields.addFieldsFromBody(rightToUseFields, rightToUse);
    putFields.addField("rightToUseRevision", res.locals.dbdata.assetUsageAgreement.assetUsageAgreementRevision);
    const goodForField = new SqlParams(putFields);
    goodForField.addField("goodFor", rightToUse.goodFor);
    const houseFields = new SqlParams(goodForField);
    houseFields.addField("rightToUseActive", true);
    houseFields.addField("modifier", res.locals.params.userId);
    houseFields.addField("closer", null);
    houseFields.addField("closed", null);
    houseFields.addField("closureReason", null);

    const insFields = new SqlParams(houseFields);
    insFields.addField("assetUsageRuleId", utils.uuid());
    insFields.addField("assigneeMetrics", rightToUse.assigneeMetrics);
    insFields.addField("metricsRevision", 0);
    insFields.addField("creator", res.locals.params.userId);

    const sqlCmd = `INSERT INTO "rightToUse" AS rtu
        (${keys.fields} ${putFields.fields} ${goodForField.fields} ${houseFields.fields} ${insFields.fields}, "created", "modified")
        VALUES (${keys.idxValues} ${putFields.idxValues} ${goodForField.idxValues} ${houseFields.idxValues} ${insFields.idxValues}, NOW(), NOW())
        ON CONFLICT (${keys.fields}) DO UPDATE
            SET "modified" = NOW(), "usageEnds" = rtu."usageStarted" + ${goodForField.idxKeyValues}::INTERVAL
                ${putFields.updates} ${goodForField.updates} ${houseFields.updates}
            WHERE rtu."rightToUseActive" = FALSE
               OR ${putFields.getWhereDistinct("rtu")} OR ${goodForField.getWhereDistinct("rtu")}
        RETURNING *`;
    const result = await pgclient.sqlQuery(res, sqlCmd, keys.getAllValues());
    if (result.rows.length) {
        rightToUse = result.rows[0];
        await snapshot.storeSnapshot(res, rightToUse.softwareLicensorId,
            "rightToUse", rightToUse.assetUsageRuleId, rightToUse.rightToUseRevision, rightToUse);
    }
    lumServer.logger.debug(res, `out storeRightToUse(${rightToUse.rightToUseId} -> ${rightToUse.assetUsageRuleId})`);
}

module.exports = {
    /**
     * retrieve assetUsageAgreement from database
     * @param  {} res
     */
    async getAssetUsageAgreement(res) {
        lumServer.logger.debug(res, `in getAssetUsageAgreement(${res.locals.paramsStr})`);

        const keys = new SqlParams();
        keys.addField("softwareLicensorId", res.locals.params.softwareLicensorId);
        keys.addField("assetUsageAgreementId", res.locals.params.assetUsageAgreementId);
        const selectFields = new SqlParams();
        selectFields.addFields(assetUsageAgreementRecord);
        selectFields.addFields(assetUsageAgreementHouse);

        const sqlCmd = `SELECT ${keys.fields}, ${selectFields.fields}
                          FROM "assetUsageAgreement" WHERE ${keys.where} FOR SHARE`;
        const result = await pgclient.sqlQuery(res, sqlCmd, keys.values);
        if (result.rows.length) {
            res.locals.dbdata.assetUsageAgreement = result.rows[0];
        }
        lumServer.logger.debug(res, "out getAssetUsageAgreement");
    },
    /**
     * revoke assetUsageAgreement
     * @param  {} res
     */
    async revokeAssetUsageAgreement(res) {
        lumServer.logger.debug(res, `in revokeAssetUsageAgreement(${res.locals.paramsStr})`);
        const keys = new SqlParams();
        keys.addField("softwareLicensorId", res.locals.params.softwareLicensorId);
        keys.addField("assetUsageAgreementId", res.locals.params.assetUsageAgreementId);
        const putFields = new SqlParams(keys);
        putFields.addField("assetUsageAgreementActive", false);
        putFields.addField("closer", res.locals.params.userId);
        putFields.addField("closureReason", "revoked");

        const sqlCmd = `UPDATE "assetUsageAgreement"
            SET "assetUsageAgreementRevision" = "assetUsageAgreementRevision" + 1, "closed" = NOW()
            ${putFields.updates} WHERE ${keys.where} RETURNING *`;
        const result = await pgclient.sqlQuery(res, sqlCmd, keys.getAllValues());
        if (result.rows.length) {
            res.locals.dbdata.assetUsageAgreement = result.rows[0];
            await snapshot.storeSnapshot(res,
                res.locals.params.softwareLicensorId,
                "assetUsageAgreement",
                res.locals.params.assetUsageAgreementId,
                res.locals.dbdata.assetUsageAgreement.assetUsageAgreementRevision,
                res.locals.dbdata.assetUsageAgreement
            );
        }
        lumServer.logger.debug(res, `out revokeAssetUsageAgreement(${res.locals.paramsStr})`);
    },
    /**
     * verify that all required properties are provided in request to PUT asset-usage-agreement
     * @param  {} res
     * @throws {InvalidDataError} when invalid data
     */
    validateAssetUsageAgreement(res) {
        lumServer.logger.debug(res, `validateAssetUsageAgreement(${res.locals.paramsStr})`);
        res.locals.assetUsageAgreement = utils.getFromReqByPath(res, "assetUsageAgreement") || {};

        const errors = [];
        if (res.locals.assetUsageAgreement.agreement == null) {
            lumErrors.addError(errors, `agreement expected`);
        } else {
            odrl.validateAgreement(errors, res.locals.assetUsageAgreement.agreement, 'agreement');
        }

        if (errors.length) {
            throw new lumErrors.InvalidDataError(errors);
        }

    },
    /**
     * insert-update assetUsageAgreement in database
     * @param  {} res
     */
    async putAssetUsageAgreement(res) {
        if (!res.locals.params.assetUsageAgreementId) {
            lumServer.logger.debug(res, `skipped putAssetUsageAgreement(${res.locals.paramsStr})`);
            return;
        }
        lumServer.logger.debug(res, `in putAssetUsageAgreement(${res.locals.paramsStr})`);

        const keys = new SqlParams();
        keys.addField("softwareLicensorId", res.locals.params.softwareLicensorId);
        keys.addField("assetUsageAgreementId", res.locals.params.assetUsageAgreementId);
        const putFields = new SqlParams(keys);
        putFields.addField("agreement", res.locals.assetUsageAgreement.agreement);
        const houseFields = new SqlParams(putFields);
        houseFields.addField("assetUsageAgreementActive", true);
        houseFields.addField("modifier", res.locals.params.userId);
        houseFields.addField("closer", null);
        houseFields.addField("closed", null);
        houseFields.addField("closureReason", null);

        const insFields = new SqlParams(houseFields);
        insFields.addField("creator", res.locals.params.userId);

        const sqlCmd = `INSERT INTO "assetUsageAgreement" AS aua
            (${keys.fields} ${putFields.fields} ${houseFields.fields} ${insFields.fields}, "created", "modified")
            VALUES (${keys.idxValues} ${putFields.idxValues} ${houseFields.idxValues} ${insFields.idxValues}, NOW(), NOW())
            ON CONFLICT (${keys.fields}) DO UPDATE
            SET "assetUsageAgreementRevision" = aua."assetUsageAgreementRevision" + 1, "groomedAgreement" = NULL
                ${putFields.updates} ${houseFields.updates}, "modified" = NOW()
            WHERE aua."assetUsageAgreementActive" = FALSE OR ${putFields.getWhereDistinct("aua")}
            RETURNING *`;
        const result = await pgclient.sqlQuery(res, sqlCmd, keys.getAllValues());
        if (result.rows.length) {
            res.locals.dbdata.assetUsageAgreement = result.rows[0];
        }
        lumServer.logger.debug(res, `out putAssetUsageAgreement(${res.locals.paramsStr})`);
    },
    /**
     * groom assetUsageAgreement and its restriction into format used by LUM for entitlement evaluation
     * @param  {} res
     */
    async groomAssetUsageAgreement(res) {
        if (!res.locals.dbdata.assetUsageAgreement) {
            lumServer.logger.debug(res, `skipped groomAssetUsageAgreement(${res.locals.paramsStr})`);
            return;
        }
        lumServer.logger.debug(res, `in groomAssetUsageAgreement(${res.locals.paramsStr})`);
        res.locals.groomedAgreement = odrl.groomAgreement(res,
            res.locals.dbdata.assetUsageAgreement.agreement,
            res.locals.dbdata.assetUsageAgreement.agreementRestriction
        );

        const keys = new SqlParams();
        keys.addField("softwareLicensorId", res.locals.params.softwareLicensorId);
        keys.addField("assetUsageAgreementId", res.locals.params.assetUsageAgreementId);
        const putFields = new SqlParams(keys);
        putFields.addField("groomedAgreement", res.locals.groomedAgreement);
        const houseFields = new SqlParams(putFields);
        houseFields.addField("modifier", res.locals.params.userId);

        const sqlCmd = `UPDATE "assetUsageAgreement" AS aua
            SET "modified" = NOW() ${putFields.updates} ${houseFields.updates}
            WHERE ${keys.getWhere("aua")} AND ${putFields.getWhereDistinct("aua")} RETURNING *`;
        const result = await pgclient.sqlQuery(res, sqlCmd, keys.getAllValues());
        if (result.rows.length) {
            res.locals.dbdata.assetUsageAgreement = result.rows[0];
            await snapshot.storeSnapshot(res,
                res.locals.params.softwareLicensorId,
                "assetUsageAgreement",
                res.locals.params.assetUsageAgreementId,
                res.locals.dbdata.assetUsageAgreement.assetUsageAgreementRevision,
                res.locals.dbdata.assetUsageAgreement
            );
        }
        lumServer.logger.debug(res, `out groomAssetUsageAgreement(${res.locals.paramsStr})`);
    },
    /**
     * insert-update rightToUse records into database per agreement
     * @param  {} res
     */
    async putRightToUse(res) {
        if (!res.locals.params.assetUsageAgreementId
        || !res.locals.dbdata.assetUsageAgreement
        || !res.locals.dbdata.assetUsageAgreement.assetUsageAgreementRevision
        || !res.locals.groomedAgreement
        || (!res.locals.groomedAgreement.permission && !res.locals.groomedAgreement.prohibition)) {
            lumServer.logger.debug(res, `skipped putRightToUse(${res.locals.paramsStr})`);
            return;
        }
        lumServer.logger.debug(res, `in putRightToUse(${res.locals.paramsStr})`);

        for await (const rightToUse of Object.values(res.locals.groomedAgreement.permission || {})) {
            await storeRightToUse(res, rightToUse);
        }
        for await (const rightToUse of Object.values(res.locals.groomedAgreement.prohibition || {})) {
            await storeRightToUse(res, rightToUse);
        }

        lumServer.logger.debug(res, `out putRightToUse(${res.locals.paramsStr})`);
    },
    /**
     * mark rightToUse records as non-active if not in agreement
     * @param  {} res
     */
    async revokeObsoleteRightToUse(res) {
        if (!res.locals.params.assetUsageAgreementId
            || !res.locals.dbdata.assetUsageAgreement
            || !res.locals.dbdata.assetUsageAgreement.assetUsageAgreementRevision) {
                lumServer.logger.debug(res, `skipped revokeObsoleteRightToUse(${res.locals.paramsStr})`);
                return;
            }
            lumServer.logger.debug(res, `in revokeObsoleteRightToUse(${res.locals.paramsStr})`);

            const keys = new SqlParams();
            keys.addField("softwareLicensorId", res.locals.params.softwareLicensorId);
            keys.addField("assetUsageAgreementId", res.locals.params.assetUsageAgreementId);
            keys.addField("rightToUseActive", true);
            const mismatchKeys = new SqlParams(keys);
            mismatchKeys.addField("rightToUseRevision", res.locals.dbdata.assetUsageAgreement.assetUsageAgreementRevision);
            const putFields = new SqlParams(mismatchKeys);
            putFields.addField("rightToUseActive", false);
            putFields.addField("closer", res.locals.params.userId);
            putFields.addField("closureReason", "revoked");

            const sqlCmd = `UPDATE "rightToUse"
                SET "rightToUseRevision" = "rightToUseRevision" + 1, "closed" = NOW() ${putFields.updates}
                WHERE ${keys.where} AND NOT (${mismatchKeys.where}) RETURNING *`;

            const result = await pgclient.sqlQuery(res, sqlCmd, keys.getAllValues());
            if (result.rows.length) {
                for await (const rightToUse of result.rows) {
                    await snapshot.storeSnapshot(res, rightToUse.softwareLicensorId,
                        "rightToUse", rightToUse.assetUsageRuleId, rightToUse.rightToUseRevision, rightToUse);
                }
            }
            lumServer.logger.debug(res, `out revokeObsoleteRightToUse(${res.locals.paramsStr})`);
    },
    /**
     * verify that all required properties are provided in request to PUT asset-usage-agreement-restriction
     * @param  {} res
     * @throws {InvalidDataError} when invalid data
     */
    validateAssetUsageAgreementRestriction(res) {
        lumServer.logger.debug(res, `validateAssetUsageAgreementRestriction(${res.locals.paramsStr})`);
        res.locals.assetUsageAgreement = utils.getFromReqByPath(res, "assetUsageAgreement") || {};

        const errors = [];
        if (res.locals.assetUsageAgreement.agreementRestriction != null) {
            odrl.validateAgreement(errors, res.locals.assetUsageAgreement.agreementRestriction, 'agreementRestriction');
        }

        if (errors.length) {
            throw new lumErrors.InvalidDataError(errors);
        }
    },
    /**
     * update assetUsageAgreementRestriction in database
     * @param  {} res
     */
    async putAssetUsageAgreementRestriction(res) {
        if (!res.locals.params.assetUsageAgreementId) {
            lumServer.logger.debug(res, `skipped putAssetUsageAgreementRestriction(${res.locals.paramsStr})`);
            return;
        }
        lumServer.logger.debug(res, `in putAssetUsageAgreementRestriction(${res.locals.paramsStr})`);

        const keys = new SqlParams();
        keys.addField("softwareLicensorId", res.locals.params.softwareLicensorId);
        keys.addField("assetUsageAgreementId", res.locals.params.assetUsageAgreementId);
        const putFields = new SqlParams(keys);
        putFields.addField("agreementRestriction", res.locals.assetUsageAgreement.agreementRestriction || null);
        const houseFields = new SqlParams(putFields);
        houseFields.addField("modifier", res.locals.params.userId);

        const sqlCmd = `UPDATE "assetUsageAgreement" AS aua
            SET "assetUsageAgreementRevision" = aua."assetUsageAgreementRevision" + 1, "groomedAgreement" = NULL
                ${putFields.updates} ${houseFields.updates}, "modified" = NOW()
            WHERE ${keys.getWhere("aua")} AND ${putFields.getWhereDistinct("aua")} RETURNING *`;
        const result = await pgclient.sqlQuery(res, sqlCmd, keys.getAllValues());
        if (result.rows.length) {
            res.locals.dbdata.assetUsageAgreement = result.rows[0];
        }
        lumServer.logger.debug(res, `out putAssetUsageAgreementRestriction(${res.locals.paramsStr})`);
    },
    /**
     * remove assetUsageAgreementRestriction from assetUsageAgreement in database
     * @param  {} res
     */
    async revokeAssetUsageAgreementRestriction(res) {
        if (!res.locals.params.assetUsageAgreementId) {
            lumServer.logger.debug(res, `skipped revokeAssetUsageAgreementRestriction(${res.locals.paramsStr})`);
            return;
        }
        lumServer.logger.debug(res, `in revokeAssetUsageAgreementRestriction(${res.locals.paramsStr})`);

        const keys = new SqlParams();
        keys.addField("softwareLicensorId", res.locals.params.softwareLicensorId);
        keys.addField("assetUsageAgreementId", res.locals.params.assetUsageAgreementId);
        const putFields = new SqlParams(keys);
        putFields.addField("agreementRestriction", null);
        const houseFields = new SqlParams(putFields);
        houseFields.addField("modifier", res.locals.params.userId);

        const sqlCmd = `UPDATE "assetUsageAgreement" AS aua
            SET "assetUsageAgreementRevision" = aua."assetUsageAgreementRevision" + 1 ${putFields.updates} ${houseFields.updates}, "modified" = NOW()
            WHERE ${keys.getWhere("aua")} AND ${putFields.getWhereDistinct("aua")}
            RETURNING *`;
        const result = await pgclient.sqlQuery(res, sqlCmd, keys.getAllValues());
        if (result.rows.length) {
            res.locals.dbdata.assetUsageAgreement = result.rows[0];
        }
        lumServer.logger.debug(res, `out revokeAssetUsageAgreementRestriction(${res.locals.paramsStr})`);
    }
};

