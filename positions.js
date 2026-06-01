/**
 * VATPAC Position Callsigns
 * Auto-generated from vatSys datasets - DO NOT EDIT MANUALLY
 *
 * Sources:
 *   - https://github.com/vatSys/australia-dataset (Sectors.xml + Positions.xml)
 *   - https://github.com/vatSys/pacific-dataset (Sectors.xml + Positions.xml)
 *
 * Last synced: 2026-06-01T08:00:45.735Z
 * Total callsigns: 265
 *
 * To update, run: node scripts/sync-positions.js
 */

// Aerodrome positions (DEL/GND/TWR)
const AERODROME = [
  'AD_DEL', 'AMB_DEL', 'BN_DEL', 'CG_DEL', 'CIN_DEL', 'CS_DEL', 'DN_DEL', 'ES_DEL',
  'ML_DEL', 'NW_DEL', 'OK_DEL', 'PE_DEL', 'PH_DEL', 'SY_DEL', 'TL_DEL', 'TN_DEL',
  'WLM_DEL', 'AD_GND', 'AF_GND', 'AMB_GND', 'AYPY_GND', 'AY_GND', 'BK_GND', 'BN-N_GND',
  'BN-S_GND', 'BN_GND', 'BRM_GND', 'CB_GND', 'CG_GND', 'CIN_GND', 'CN_GND', 'CS_GND',
  'DN_GND', 'ED_GND', 'EN_GND', 'ES_GND', 'GIG_GND', 'HB_GND', 'JT_GND', 'KA_GND',
  'KWA_GND', 'LM_GND', 'MB_GND', 'MK_GND', 'ML_GND', 'NFFN_GND', 'NWWW_GND', 'NW_GND',
  'OK_GND', 'PE_GND', 'PF_GND', 'PH-E_GND', 'PH_GND', 'PKWA_GND', 'RI_GND', 'RK_GND',
  'SG_GND', 'SU_GND', 'SY-C_GND', 'SY-W_GND', 'SY_GND', 'TL_GND', 'TN_GND', 'TW_GND',
  'WLM_GND', 'AD_TWR', 'AF-N_TWR', 'AF_TWR', 'AMB_TWR', 'AS_TWR', 'AV_TWR', 'AYGA_TWR',
  'AYMD_TWR', 'AYMH_TWR', 'AYNZ_TWR', 'AYPY_TWR', 'AYTK_TWR', 'AY_TWR', 'BK-C_TWR', 'BK_TWR',
  'BN-W_TWR', 'BN_TWR', 'BRM_TWR', 'CB_TWR', 'CFS_TWR', 'CG_TWR', 'CIN_TWR', 'CN_TWR',
  'CS_TWR', 'DN_TWR', 'ED_TWR', 'EN_TWR', 'ES_TWR', 'GIG_TWR', 'HB_TWR', 'HM_TWR',
  'JT-C_TWR', 'JT_TWR', 'KA_TWR', 'KWA_TWR', 'LM_TWR', 'LT_TWR', 'MB-W_TWR', 'MB_TWR',
  'MK_TWR', 'ML_TWR', 'NFFN_TWR', 'NFNA_TWR', 'NVVV_TWR', 'NWWL_TWR', 'NWWM_TWR', 'NWWW_TWR',
  'NW_TWR', 'OK_TWR', 'PE_TWR', 'PF-W_TWR', 'PF_TWR', 'PH_TWR', 'PKWA_TWR', 'RI_TWR',
  'RK_TWR', 'SG_TWR', 'SU_TWR', 'SY-E_TWR', 'SY_TWR', 'TL_TWR', 'TN_TWR', 'TW-S_TWR',
  'TW_TWR', 'WLM_TWR', 'WR_TWR'
];

// Approach/Departure positions (APP/DEP)
const APPROACH = [
  'AD-W_APP', 'AD_APP', 'AMB_APP', 'AV_APP', 'AYNZ_APP', 'AYPY_APP', 'BN-C_APP', 'BN-F_APP',
  'BN-S_APP', 'BN_APP', 'CB-W_APP', 'CB_APP', 'CIN_APP', 'CS-W_APP', 'CS_APP', 'DN-W_APP',
  'DN_APP', 'ES_APP', 'HB_APP', 'LM_APP', 'LT_APP', 'MK_APP', 'ML_APP', 'NFFN_APP',
  'NFNA_APP', 'NVVV_APP', 'NWWM_APP', 'NWWW_APP', 'NW_APP', 'OK_APP', 'PE_APP', 'PH_APP',
  'RK_APP', 'SG_APP', 'SY-DE_APP', 'SY-D_APP', 'SY-N_APP', 'SY_APP', 'TL_APP', 'TN_APP',
  'WLM-H_APP', 'WLM_APP', 'AD-R_DEP', 'BN-R_DEP', 'BN-S_DEP', 'BN_DEP', 'ML-R_DEP', 'ML-S_DEP',
  'ML_DEP', 'PH-R_DEP', 'PH_DEP', 'SY-N_DEP', 'SY-R_DEP', 'SY_DEP'
];

// Enroute positions (CTR/FSS)
const ENROUTE = [
  'AYPM_CTR', 'BN-ARA_CTR', 'BN-ARL_CTR', 'BN-ASH_CTR', 'BN-BAR_CTR', 'BN-BUR_CTR', 'BN-CNK_CTR', 'BN-CVN_CTR',
  'BN-DOS_CTR', 'BN-GOL_CTR', 'BN-HWE_CTR', 'BN-INL_CTR', 'BN-ISA_CTR', 'BN-KEN_CTR', 'BN-KIY_CTR', 'BN-KPL_CTR',
  'BN-MDE_CTR', 'BN-MLD_CTR', 'BN-MNN_CTR', 'BN-NSA_CTR', 'BN-OCN_CTR', 'BN-SDY_CTR', 'BN-STR_CTR', 'BN-SWY_CTR',
  'BN-TBP_CTR', 'BN-TRS_CTR', 'BN-TRT_CTR', 'BN-WEG_CTR', 'BN-WIL_CTR', 'ML-ASP_CTR', 'ML-ASW_CTR', 'ML-AUG_CTR',
  'ML-BIK_CTR', 'ML-BKE_CTR', 'ML-BLA_CTR', 'ML-ELW_CTR', 'ML-ESP_CTR', 'ML-FOR_CTR', 'ML-GEL_CTR', 'ML-GTH_CTR',
  'ML-GUN_CTR', 'ML-GVE_CTR', 'ML-HUO_CTR', 'ML-HYD_CTR', 'ML-JAR_CTR', 'ML-KAT_CTR', 'ML-LEA_CTR', 'ML-MEK_CTR',
  'ML-MTK_CTR', 'ML-MUN_CTR', 'ML-MZI_CTR', 'ML-NEW_CTR', 'ML-OLW_CTR', 'ML-OXL_CTR', 'ML-PAR_CTR', 'ML-PIY_CTR',
  'ML-POT_CTR', 'ML-SCR_CTR', 'ML-SNO_CTR', 'ML-TBD_CTR', 'ML-WAR_CTR', 'ML-WOL_CTR', 'ML-WON_CTR', 'ML-WRA_CTR',
  'ML-YWE_CTR', 'NFFJ_CTR', 'BN-COL_FSS', 'BN-FLD_FSS', 'BN-TSN_FSS', 'ML-IND_FSS', 'ML-INE_FSS', 'ML-INS_FSS',
  'NFFF_FSS'
];

// Flow positions (FMP)
const FLOW = [
  'AD_FMP', 'BN_FMP', 'CB_FMP', 'CS_FMP', 'ML_FMP', 'PH_FMP', 'SY_FMP'
];


/**
 * Complete set of all VATPAC callsigns
 * Used by workers to identify VATPAC controller sessions on VATSIM
 */
export const VATPAC_CALLSIGNS = new Set([
  ...AERODROME,
  ...APPROACH,
  ...ENROUTE,
  ...FLOW
]);

/**
 * Array version for StatSim API queries
 */
export const PAC_CALLSIGNS = [...VATPAC_CALLSIGNS];
