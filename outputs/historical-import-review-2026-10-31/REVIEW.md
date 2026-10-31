# Historical import source review — 2026-10-31

No production changes have been made. Original Excel files are unchanged. This package is a preflight, not an import.

## Source counts

| Sheet | Rows |
|---|---:|
| BOQ Headers | 23 |
| BOQ Items | 984 |
| Projects | 23 |
| Project Team | 23 |
| Clients | 17 |
| Contacts | 17 |

## Key findings

- Item references and financial values are preserved exactly; none of the following corrections has been guessed.
- Client Contacts has phone-like numbers in PRIMARY_CONTACT, with PHONE blank, on all 17 rows.
- BOQ-2026-0001 has 15 items but no matching header; BOQ-2024-0001 has a header but no items.
- Employee codes differ between Projects and Project Team.
- No live database duplicate matching has been performed.

## BOQ reconciliation

Calculated totals round each quantity x rate to cents; small discrepancies may be rounding, but are visible here.

| BOQ code | Header Excel row | Items | Declared | Stated line total | Calculated line total | Stated minus declared |
|---|---:|---:|---:|---:|---:|---:|
| BOQ-2024-0001 | 6 | 0 | 5,211,500.00 | 0.00 | 0.00 | -5,211,500.00 |
| BOQ-2024-0002 | 7 | 19 | 0.05 | 3,704,531.00 | 3,704,530.65 | 3,704,530.95 |
| BOQ-2024-0003 | 8 | 37 | 14,433,730.00 | 14,433,730.00 | 14,433,730.00 | 0.00 |
| BOQ-2024-0004 | 9 | 15 | 4,750,444.00 | 4,509,080.00 | 4,509,080.00 | -241,364.00 |
| BOQ-2024-0005 | 10 | 63 | 7,256,632.20 | 7,256,632.20 | 7,256,632.20 | 0.00 |
| BOQ-2024-0006 | 11 | 23 | 3,539,865.45 | 3,523,725.45 | 3,523,648.05 | -16,140.00 |
| BOQ-2024-0007 | 12 | 11 | 2,269,105.00 | 2,269,105.00 | 2,269,105.00 | 0.00 |
| BOQ-2024-0008 | 13 | 23 | 3,785,750.00 | 3,851,780.00 | 3,791,780.00 | 66,030.00 |
| BOQ-2024-0009 | 14 | 12 | 960,471.89 | 965,471.88 | 965,471.89 | 4,999.99 |
| BOQ-2024-0010 | 15 | 41 | 1,372,676.05 | 1,373,000.74 | 1,373,000.74 | 324.69 |
| BOQ-2024-0011 | 16 | 46 | 9,650,520.00 | 9,565,250.00 | 9,565,250.00 | -85,270.00 |
| BOQ-2024-0012 | 17 | 6 | 6,145,400.00 | 6,145,400.00 | 6,145,400.00 | 0.00 |
| BOQ-2024-0013 | 18 | 6 | 7,580,600.00 | 7,580,600.00 | 7,580,600.00 | 0.00 |
| BOQ-2024-0014 | 19 | 6 | 5,841,016.00 | 5,841,016.00 | 5,841,016.00 | 0.00 |
| BOQ-2024-0015 | 20 | 6 | 5,841,016.00 | 5,841,016.00 | 5,841,016.00 | 0.00 |
| BOQ-2024-0017 | 21 | 18 | 3,360,650.00 | 3,360,650.00 | 3,360,650.00 | 0.00 |
| BOQ-2024-0018 | 22 | 53 | 7,140,820.00 | 7,140,820.00 | 7,140,820.00 | 0.00 |
| BOQ-2024-0019 | 23 | 125 | 11,935,298.50 | 11,935,298.50 | 11,935,298.02 | 0.00 |
| BOQ-2024-0020 | 24 | 82 | 8,619,123.70 | 8,619,123.69 | 8,619,123.69 | -0.01 |
| BOQ-2024-0021 | 25 | 30 | 16,764,133.18 | 16,764,133.18 | 16,764,133.18 | 0.00 |
| BOQ-2024-0022 | 26 | 255 | 20,995,933.51 | 20,995,933.51 | 20,995,933.51 | 0.00 |
| BOQ-2024-0023 | 27 | 70 | 13,440,869.00 | 13,440,809.00 | 13,440,869.00 | -60.00 |
| BOQ-2024-0016 | 28 | 22 | 1,139,598.00 | 1,139,598.00 | 1,139,598.00 | 0.00 |

## Issues requiring review

| Sheet | Excel row | Field | Finding |
|---|---:|---|---|
| Contacts | 6 | PRIMARY_CONTACT | Contains 711261670 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 7 | PRIMARY_CONTACT | Contains 711261670 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 8 | PRIMARY_CONTACT | Contains 711261670 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 9 | PRIMARY_CONTACT | Contains 711261670 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 10 | PRIMARY_CONTACT | Contains 352229563 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 11 | PRIMARY_CONTACT | Contains 711261670 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 12 | PRIMARY_CONTACT | Contains 711261670 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 13 | PRIMARY_CONTACT | Contains 711261670 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 14 | PRIMARY_CONTACT | Contains 352229563 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 15 | PRIMARY_CONTACT | Contains 352229563 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 16 | PRIMARY_CONTACT | Contains 704316199 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 17 | PRIMARY_CONTACT | Contains 262222753 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 18 | PRIMARY_CONTACT | Contains 352229563 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 19 | PRIMARY_CONTACT | Contains 711324111 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 20 | PRIMARY_CONTACT | Contains 771876893 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 21 | PRIMARY_CONTACT | Contains 352229563 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Contacts | 22 | PRIMARY_CONTACT | Contains 773358505 instead of Yes/No; PHONE is blank. Confirm the phone and primary-contact flag; no number is moved or padded automatically. |
| Projects | 6 | COMPANY | Confirm company alias GKUC Ready mix = GKUC Readymix; resolve against live company IDs, never assume ID 2. |
| Projects | 6 | CURRENT_BUDGET_LKR | Blank budget: do not substitute contract value or zero without deciding the intended initial budget. |
| Projects | 7 | STAGE / STATUS / PROGRESS_PERCENT | Stage=Completed, status=Current, progress=50%; confirm the intended lifecycle state. |
| Projects | 7 | CONTRACT_VALUE_LKR | Value is 0.05; confirm whether this is an amount or a percentage/rate contract. |
| Projects | 7 | CURRENT_BUDGET_LKR | Blank budget: do not substitute contract value or zero without deciding the intended initial budget. |
| Projects | 8 | CURRENT_BUDGET_LKR | Blank budget: do not substitute contract value or zero without deciding the intended initial budget. |
| Projects | 9 | COMPANY | Confirm company alias GKUC Ready mix = GKUC Readymix; resolve against live company IDs, never assume ID 2. |
| Projects | 10 | COMPANY | Confirm company alias GKUC Ready mix = GKUC Readymix; resolve against live company IDs, never assume ID 2. |
| Projects | 10 | AWARD_REFERENCE | Award date present without an award reference. Do not invent an award record/reference. |
| Projects | 11 | COMPANY | Confirm company alias GKUC Ready mix = GKUC Readymix; resolve against live company IDs, never assume ID 2. |
| Projects | 12 | COMPANY | Confirm company alias GKUC Ready mix = GKUC Readymix; resolve against live company IDs, never assume ID 2. |
| Projects | 13 | COMPANY | Confirm company alias GKUC Ready mix = GKUC Readymix; resolve against live company IDs, never assume ID 2. |
| Projects | 14 | COMPANY | Confirm company alias GKUC Ready mix = GKUC Readymix; resolve against live company IDs, never assume ID 2. |
| Projects | 14 | AWARD_REFERENCE | Award date present without an award reference. Do not invent an award record/reference. |
| Projects | 15 | COMPANY | Confirm company alias GKUC Ready mix = GKUC Readymix; resolve against live company IDs, never assume ID 2. |
| Projects | 15 | AWARD_REFERENCE | Award date present without an award reference. Do not invent an award record/reference. |
| Projects | 16 | COMPANY | Confirm company alias GKUC Ready mix = GKUC Readymix; resolve against live company IDs, never assume ID 2. |
| Projects | 17 | STAGE / STATUS / PROGRESS_PERCENT | Stage=Completed, status=Completed, progress=50%; confirm the intended lifecycle state. |
| Projects | 17 | CONTRACT_VALUE_LKR | More than two currency decimals; confirm rounding before storing an amount. |
| Projects | 18 | STAGE / STATUS / PROGRESS_PERCENT | Stage=Completed, status=Completed, progress=50%; confirm the intended lifecycle state. |
| Projects | 18 | CONTRACT_VALUE_LKR | More than two currency decimals; confirm rounding before storing an amount. |
| Projects | 19 | STAGE / STATUS / PROGRESS_PERCENT | Stage=Completed, status=Completed, progress=50%; confirm the intended lifecycle state. |
| Projects | 20 | STAGE / STATUS / PROGRESS_PERCENT | Stage=Completed, status=Completed, progress=50%; confirm the intended lifecycle state. |
| Projects | 22 | AWARD_REFERENCE | Award date present without an award reference. Do not invent an award record/reference. |
| Projects | 23 | STAGE / STATUS / PROGRESS_PERCENT | Stage=Completed, status=Completed, progress=50%; confirm the intended lifecycle state. |
| Projects | 6 | PROJECT_NAME | 338 characters exceeds current database limit 180; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Headers | 6 | TITLE | 342 characters exceeds current database limit 180; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 210 | DESCRIPTION | 315 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 233 | DESCRIPTION | 377 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 234 | DESCRIPTION | 509 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 271 | DESCRIPTION | 326 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 347 | DESCRIPTION | 376 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 352 | DESCRIPTION | 557 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 356 | DESCRIPTION | 388 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 363 | DESCRIPTION | 339 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 365 | DESCRIPTION | 331 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 366 | DESCRIPTION | 335 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 368 | DESCRIPTION | 323 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 372 | DESCRIPTION | 335 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 373 | DESCRIPTION | 323 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 379 | DESCRIPTION | 331 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 385 | DESCRIPTION | 331 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 391 | DESCRIPTION | 331 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 393 | DESCRIPTION | 335 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 394 | DESCRIPTION | 323 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 402 | DESCRIPTION | 331 characters exceeds current database limit 300; choose a shorter display label with full source retained, or explicitly extend schema. No silent truncation. |
| BOQ Items | 6 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 7 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 8 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 9 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 10 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 11 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 12 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 13 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 14 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 15 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 16 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 17 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 18 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 19 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 20 | BOQ_CODE | No BOQ Header for BOQ-2026-0001; header BOQ-2024-0001 has no items. Confirm mapping; no year/code correction applied. |
| BOQ Items | 25 | QUANTITY / RATE_LKR / AMOUNT_LKR | Quantity x rate = 16,089.65; stated amount = 16,090.00; difference = 0.35. Confirm the correct values; no recalculation overwrites source. |
| BOQ Items | 167 | QUANTITY / RATE_LKR / AMOUNT_LKR | Quantity x rate = 42,995.70; stated amount = 43,073.10; difference = 77.40. Confirm the correct values; no recalculation overwrites source. |
| BOQ Items | 208 | QUANTITY / RATE_LKR / AMOUNT_LKR | Quantity x rate = 33,750.00; stated amount = 93,750.00; difference = 60,000.00. Confirm the correct values; no recalculation overwrites source. |
| BOQ Items | 413 | QUANTITY / RATE_LKR / AMOUNT_LKR | Quantity x rate = 14,909.52; stated amount = 14,910.00; difference = 0.48. Confirm the correct values; no recalculation overwrites source. |
| BOQ Items | 964 | QUANTITY / RATE_LKR / AMOUNT_LKR | Quantity x rate = 46,575.00; stated amount = 46,515.00; difference = -60.00. Confirm the correct values; no recalculation overwrites source. |
| BOQ Items | 353 | BOQ_CODE + LINE_NO | Duplicate key ('BOQ-2024-0018', '1.1'); rows 353, 362. Confirm both are distinct work or a duplicate. |
| BOQ Items | 362 | BOQ_CODE + LINE_NO | Duplicate key ('BOQ-2024-0018', '1.1'); rows 353, 362. Confirm both are distinct work or a duplicate. |
| BOQ Headers | 6 | DECLARED_TOTAL_LKR | BOQ-2024-0001: declared 5,211,500.00; 0 matching lines sum to 0.00; difference -5,211,500.00. Do not approve or change project budget from this unreconciled source. |
| BOQ Headers | 7 | DECLARED_TOTAL_LKR | BOQ-2024-0002: declared 0.05; 19 matching lines sum to 3,704,531.00; difference 3,704,530.95. Do not approve or change project budget from this unreconciled source. |
| BOQ Headers | 9 | DECLARED_TOTAL_LKR | BOQ-2024-0004: declared 4,750,444.00; 15 matching lines sum to 4,509,080.00; difference -241,364.00. Do not approve or change project budget from this unreconciled source. |
| BOQ Headers | 11 | DECLARED_TOTAL_LKR | BOQ-2024-0006: declared 3,539,865.45; 23 matching lines sum to 3,523,725.45; difference -16,140.00. Do not approve or change project budget from this unreconciled source. |
| BOQ Headers | 13 | DECLARED_TOTAL_LKR | BOQ-2024-0008: declared 3,785,750.00; 23 matching lines sum to 3,851,780.00; difference 66,030.00. Do not approve or change project budget from this unreconciled source. |
| BOQ Headers | 14 | DECLARED_TOTAL_LKR | BOQ-2024-0009: declared 960,471.89; 12 matching lines sum to 965,471.88; difference 4,999.99. Do not approve or change project budget from this unreconciled source. |
| BOQ Headers | 15 | DECLARED_TOTAL_LKR | BOQ-2024-0010: declared 1,372,676.05; 41 matching lines sum to 1,373,000.74; difference 324.69. Do not approve or change project budget from this unreconciled source. |
| BOQ Headers | 16 | DECLARED_TOTAL_LKR | BOQ-2024-0011: declared 9,650,520.00; 46 matching lines sum to 9,565,250.00; difference -85,270.00. Do not approve or change project budget from this unreconciled source. |
| BOQ Headers | 27 | DECLARED_TOTAL_LKR | BOQ-2024-0023: declared 13,440,869.00; 70 matching lines sum to 13,440,809.00; difference -60.00. Do not approve or change project budget from this unreconciled source. |
| Project Team | 6 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 7 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 8 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 9 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 10 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 11 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 12 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 13 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 14 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 15 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 16 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 17 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 18 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 19 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 20 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 21 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 22 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 23 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 24 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 25 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 26 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 27 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Project Team | 28 | ASSIGNED_DATE | No assignment date supplied. Do not create a false historical date. |
| Projects | — | PROJECT_MANAGER_EMPLOYEE_CODE | All 23 managers use EMP-001; all 23 team rows use EMP-0001. Confirm employee identity against the live employee register; codes are not assumed equivalent. |
| Database | — | EXISTING RECORDS | Production database was not supplied. Existing record IDs, duplicates, company IDs, employee identities, permissions and exact schema must be checked against that database before final insert-only SQL can be verified. |
| Database | — | AUDIT USER | No import actor was specified. Resolve the actual user ID; do not invent preparer/approver/audit attribution for historical approved BOQs. |
| BOQ Headers | 6 | SOURCE_FILENAME | Placeholder filename; no actual source PDF supplied. Workbook provenance can be retained but this is not an uploaded approval proof. |
| BOQ Headers | 7 | SOURCE_FILENAME | Placeholder filename; no actual source PDF supplied. Workbook provenance can be retained but this is not an uploaded approval proof. |
| BOQ Headers | 8 | SOURCE_FILENAME | Placeholder filename; no actual source PDF supplied. Workbook provenance can be retained but this is not an uploaded approval proof. |
| BOQ Headers | 9 | SOURCE_FILENAME | Placeholder filename; no actual source PDF supplied. Workbook provenance can be retained but this is not an uploaded approval proof. |
| BOQ Headers | 10 | SOURCE_FILENAME | Placeholder filename; no actual source PDF supplied. Workbook provenance can be retained but this is not an uploaded approval proof. |
| BOQ Headers | 11 | SOURCE_FILENAME | Placeholder filename; no actual source PDF supplied. Workbook provenance can be retained but this is not an uploaded approval proof. |
| BOQ Headers | 12 | SOURCE_FILENAME | Placeholder filename; no actual source PDF supplied. Workbook provenance can be retained but this is not an uploaded approval proof. |
| BOQ Headers | 13 | SOURCE_FILENAME | Placeholder filename; no actual source PDF supplied. Workbook provenance can be retained but this is not an uploaded approval proof. |
| BOQ Headers | 14 | SOURCE_FILENAME | Placeholder filename; no actual source PDF supplied. Workbook provenance can be retained but this is not an uploaded approval proof. |
| BOQ Headers | 15 | SOURCE_FILENAME | Placeholder filename; no actual source PDF supplied. Workbook provenance can be retained but this is not an uploaded approval proof. |
| BOQ Headers | 16 | SOURCE_FILENAME | Placeholder filename; no actual source PDF supplied. Workbook provenance can be retained but this is not an uploaded approval proof. |

## Safe next steps

1. Run `01_preflight_only.sql` in the existing application database and export all result tables, or provide a local database export path. It reads live registers and writes only temporary session tables. It never imports source data into application tables.
2. Resolve the workbook issues above; provide confirmed employee mapping and any explicit existing-record ID mappings.
3. Generate the final transaction-based insert-only import against those confirmed values and the actual target schema. Existing records must be reused or skipped; ambiguous matches must stop the whole batch.
4. Validate against a separate copy of that database, comparing every pre-existing row before/after and rerunning the import. Back up the target and run during a write pause to avoid concurrent duplicates.
5. Keep historical approval evidence distinct from the importing user; no project budget, expenses, payments or existing BOQ approvals should be changed by the data load.

## Source SHA-256

- `03_GKUC_BOQs_Import_Template.xlsx`: `b61003da756c5417cebbe7cd669a22ec76f51dea885045723660e61bfffbeecb`
- `~$02_GKUC_Projects_Import_Template.xlsx`: `30b94dfea45b52890f6a13e5092c3d539ccbab08f7c3e9ffd6f0fb7ffa207e34`
- `~$01_GKUC_Clients_Import_Template.xlsx`: `30b94dfea45b52890f6a13e5092c3d539ccbab08f7c3e9ffd6f0fb7ffa207e34`
- `02_GKUC_Projects_Import_Template.xlsx`: `d19303bb2e9dce691428e847bb29fffe4fe14c63a80b2088c3e93564cda5f1bf`
- `01_GKUC_Clients_Import_Template.xlsx`: `df8f0a92e2a0a89ca158a24d438ce2309fd02320a5a973d15547c987ff22a2b2`

## Local validation completed

The exact preflight SQL executed twice against a disposable database built from the current application schema, seeded with data and deliberately matching existing client/project/BOQ records. Every pre-existing row across 176 base tables had the same count and SHA-256 fingerprint after each run. Evidence is in VALIDATION.json. This validates the preflight only; it is not production import proof. The test database was removed after verification.
