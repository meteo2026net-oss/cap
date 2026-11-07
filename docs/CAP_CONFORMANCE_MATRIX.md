# CAP 1.2 Conformance Matrix

This matrix records the automated conformance coverage currently present in this repository. It distinguishes local implementation tests from independent receiver interoperability and institutional acceptance. A passing XSD test is not a certification.

## Automated coverage

| Area | Current automated evidence | Coverage status |
|---|---|---|
| CAP namespace and XML serialization | `tests/cap.test.js`: XML export and namespace assertions; `tests/cap-schema.test.js`: official OASIS CAP 1.2 XSD validation plus negative controls proving the independent `xmllint` validator rejects a missing required sender, missing required event, invalid severity and urgency enumerations, invalid message-type enumeration, duplicate sender elements, and a missing required area description | Implemented |
| Message types | `tests/cap-schema.test.js`: Alert, Update, Cancel, Ack, and Error are generated and validated against the XSD | Basic type matrix covered |
| Alert info blocks | `tests/cap.test.js`: required event/area, category and responseType enumerations, language tags, headline length, expiry ordering, multilingual blocks, optional metadata and parameters | Expanded local coverage |
| Update references | `tests/cap.test.js`: required references, multiple triplets, timestamp/calendar/offset validation; XSD validates the generated Update | Implemented locally |
| Cancel references | `tests/cap.test.js`: required references and no-info message structure | Basic coverage |
| Ack and Error | `tests/cap.test.js`: references required, XML export, no-info structure; XSD matrix validates both | Basic coverage |
| Date/time values | `tests/cap.test.js`: invalid dates, expiry/onset order, effective/onset/expires serialization, impossible calendar dates, invalid clock values and ±14:00 offset boundaries | Expanded local coverage |
| Multilingual content | `tests/cap.test.js`: English and Arabic info blocks; language-tag validation | Basic coverage |
| Geometry | `tests/cap.test.js`: closed polygons, coordinate bounds, circles and positive radius, geocodes, altitude/ceiling ordering and area serialization | Expanded local coverage |
| Resources | `tests/cap.test.js`: mandatory resource description and MIME type, size, URI, dereferenced URI and digest serialization | Expanded local coverage |
| Public feed isolation | `tests/api.integration.test.js`: public feed and GeoJSON filtering, including expired and non-public/test data | Local API coverage |
| Update/Cancel history | `tests/api.integration.test.js`: derived messages, relations, timeline and delivery outbox linkage | Local workflow coverage |

## Required follow-up before interoperability acceptance

- Continue positive and negative cases for optional CAP elements and malformed calendar date-times; the newly covered metadata/resource/parameter cases remain subject to XSD and receiver interoperability checks.
- Run the isolated restore drill (`npm run restore:drill -- <backup-file>`) against a representative backup and retain its report; CI now covers the drill workflow with a synthetic database.
- Validate representative production-profile messages with an independent CAP validator in addition to the bundled OASIS XSD.
- Exchange Alert, Update, Cancel, Ack, and Error test messages with each intended receiving organization/provider.
- Record receiver name/version, test date, message identifiers, acknowledgements, rejected-message diagnostics, and written acceptance.
- Confirm operational policy for Test/Exercise messages, correction/cancellation chains, multilingual publication, and geographic coding with the authorized warning authority.

## Evidence boundary

The GitHub Actions CAP system checks install an XML Schema validator, execute the Node test suite, and validate generated messages against the official OASIS CAP 1.2 XSD. This establishes repository-level automated evidence only. It does not establish interoperability with a receiver, legal authority to issue warnings, or production approval.
