# CAP 1.2 API examples

These examples are for private development and interoperability testing only. The server deliberately creates new alerts and derived Update/Cancel messages with CAP status `Test`. They are not public-warning instructions and must not be treated as operational notices.

## Create a multilingual warning draft

Authenticated role: `admin` or `forecaster`.

`POST /api/alerts`

```json
{
  "scope": "Public",
  "status": "Test",
  "info_blocks": [
    {
      "language": "en-GB",
      "categories": ["Met"],
      "event": "Heavy rainfall",
      "urgency": "Expected",
      "severity": "Moderate",
      "certainty": "Likely",
      "headline": "Heavy rain test message",
      "description": "Test content for multilingual CAP processing.",
      "instruction": "Continue to monitor official information.",
      "areas": [
        {
          "areaDesc": "Example district",
          "polygon": "51.5000,-0.1000 51.5100,-0.1000 51.5100,-0.0800 51.5000,-0.0800 51.5000,-0.1000",
          "geocodes": [
            { "valueName": "LOCAL_DISTRICT", "value": "EXAMPLE-001" }
          ]
        }
      ],
      "resources": [
        {
          "resourceDesc": "Test map",
          "mimeType": "image/png",
          "uri": "https://example.org/test-map.png"
        }
      ]
    },
    {
      "language": "ar",
      "category": "Met",
      "event": "هطول أمطار غزيرة",
      "urgency": "Expected",
      "severity": "Moderate",
      "certainty": "Likely",
      "headline": "رسالة اختبار للأمطار",
      "description": "محتوى تجريبي لاختبار تعدد اللغات في CAP.",
      "areas": [
        {
          "areaDesc": "منطقة تجريبية",
          "circle": "51.5050,-0.0900 2"
        }
      ]
    }
  ]
}
```

The server stores the multilingual blocks as JSON and uses the first block to populate the legacy dashboard summary fields. The CAP XML export emits one `info` element per language block.

## Derive an Update or Cancel draft

Authenticated role: `admin` or `forecaster`. The source alert must already be reviewed (`approved` or `published`).

`POST /api/alerts/:id/derive`

Update body:

```json
{ "msg_type": "Update" }
```

Cancel body:

```json
{ "msg_type": "Cancel" }
```

The derived message gets a new identifier and a CAP `references` value in the form `sender,identifier,sent`. It is created as a draft with CAP status `Test`; it must pass the normal independent review and publication workflow. Cancel XML omits `info` and references the earlier message.

## Export

`GET /api/alerts/:id/cap.xml`

The generated CAP date-time values use numeric UTC offsets (for example `-00:00`), not the `Z` suffix. The GitHub Actions workflow downloads the official OASIS CAP 1.2 XSD and runs `xmllint` against a multilingual sample message.

## Administrator account status

An authenticated administrator can activate or deactivate a team account:

`PATCH /api/users/:id/status`

```json
{ "active": false }
```

The server rejects self-deactivation and prevents deactivating the last active administrator. Account status changes are recorded in the audit log. Reactivation uses `{ "active": true }`.

## Search, filter and paginate internal alerts

`GET /api/alerts` is authenticated and accepts optional query parameters:

- `q`: case-insensitive substring search across identifier, event, headline and affected-area description (maximum 160 characters).
- `workflow`: `draft`, `pending`, `approved`, `published` or `cancelled`.
- `severity`: `Extreme`, `Severe`, `Moderate`, `Minor` or `Unknown`.
- `status`: CAP status `Actual`, `Exercise`, `System` or `Test`.
- `limit`: page size from 0 to 500; defaults to 100.
- `offset`: zero-based row offset from 0 to 1,000,000; defaults to 0.

The response retains the `alerts` array and adds `pagination` with `total`, `limit`, `offset` and `has_more`. Invalid filters or pagination values return HTTP 400.

Example:

`GET /api/alerts?q=rain&workflow=published&severity=Severe&limit=25&offset=0`

The dashboard exposes the same search and filters with previous/next page controls.

## Read alert details and public feed

- `GET /api/alerts/:id` (authenticated) returns the alert record and a parsed `info_blocks` array; the internal `info_json` storage column is not exposed.
- `GET /api/public/alerts` (public, read-only) returns only alerts with workflow `published`, CAP status `Actual`, and scope `Public`. The response includes CAP metadata, geometry, references, and parsed multilingual `info_blocks`.

The public feed is an integration data endpoint, not a substitute for an institution's official alert dissemination channels or public-facing accessibility review.

## Supported structured fields

- Multiple `info_blocks` with language tags.
- Multiple categories and response types per information block.
- Multiple affected areas, polygons, circles and geocodes.
- Altitude and ceiling.
- Supplemental resources with description, MIME type, size, URI, dereferenced URI and digest.
- Parameters, sender name, web URL, contact, and references.
- Update and Cancel message drafts linked to a previous alert.

The dashboard provides an advanced JSON editor for multilingual `info_blocks`, and approved or published alerts expose Update and Cancel draft actions. A guided visual multilingual editor and interactive map-drawing UI remain future work.


## Public GeoJSON feed

`GET /api/public/alerts.geojson` returns a GeoJSON `FeatureCollection` containing geometry from published alerts only when CAP `scope` is `Public` and CAP `status` is `Actual`. CAP polygon coordinate pairs are converted from latitude,longitude to GeoJSON longitude,latitude order. CAP circles are emitted as GeoJSON `Point` features with `geometry_kind: circle` and `radius_km` properties because GeoJSON has no native circle geometry. Each polygon or circle becomes a separate feature; multilingual and multi-area info blocks are included.
## Export filtered internal alerts as CSV

`GET /api/alerts/export.csv` requires an authenticated session and accepts the same `q`, `workflow`, `severity` and `status` filters as `GET /api/alerts`. The export is sorted newest first and includes identifier, event, headline, affected area, urgency, severity, certainty, CAP status, workflow, message type, sent time and expiry.

- The export is limited to 5,000 rows. If more rows match, the endpoint returns HTTP 413 and asks the user to narrow the filters.
- CSV fields are quoted and embedded quotes are escaped. The response includes a UTF-8 BOM for spreadsheet compatibility.
- Cells beginning with formula-triggering characters are prefixed with an apostrophe to reduce spreadsheet formula-injection risk.
- Responses are marked `Cache-Control: no-store` and are not available from the public feed.
- The dashboard export button carries the current search and filter selections into the downloaded file.

Example: `GET /api/alerts/export.csv?q=rain&workflow=published&severity=Severe`
## Global alert statistics

`GET /api/alerts/stats` requires authentication and returns counts across the complete alert table, independent of the current list search, filters or page offset. The `stats` object includes `total`, workflow counts (`drafts`, `pending`, `approved`, `published`, `cancelled`), severity counts (`extreme`, `severe`, `moderate`, `minor`) and CAP status counts (`actual`, `test`, `exercise`, `system`). Empty groups are returned as zero. The dashboard uses this endpoint so its summary counters no longer change when the user moves between pages or filters the alert list.
## Export the audit history as CSV

`GET /api/audit/export.csv` exports the append-only audit history for administrators, reviewers and approvers. Both `GET /api/audit` and the export endpoint support an exact `action` filter and a `q` substring search across action, details and username. The paginated history endpoint combines these filters with its `before_id` cursor, so older-page navigation stays within the selected filter. The CSV includes the event ID, timestamp, actor, related alert ID, action, details, previous hash and entry hash.

- Export is capped at 10,000 rows; narrow the filters if the cap is exceeded.
- CSV cells are quoted and formula-like leading characters are neutralized using the same CSV safety helper as alert exports.
- The response uses UTF-8 BOM, `Cache-Control: no-store` and an attachment filename of `cap-audit-export.csv`.
- The dashboard provides a direct export action in the restricted audit-history panel. Existing audit role restrictions also apply to export.

Examples: `GET /api/audit/export.csv` and `GET /api/audit/export.csv?action=login_succeeded&q=admin`

## Inspect the CAP message relationship history

`GET /api/alerts/:id/relations` requires authentication and returns the selected message together with CAP messages linked through their `references` triples. Parent messages are resolved by sender, identifier and sent timestamp; child messages are discovered through their stored references. The result is ordered by sent time and capped at 100 messages to keep the response bounded.

The response includes `root_id`, `count`, `truncated` and a `messages` array with CAP identifiers, message types, workflow states, CAP status and reference values. The dashboard exposes this history from each alert card through the “سلسلة الرسائل” action. This is an internal relationship view; it does not change approval, cancellation or publication state.

Example: `GET /api/alerts/42/relations`
## Return a pending warning to its author

Reviewers, approvers and administrators can return a pending warning to its author when corrections are required:

`POST /api/alerts/:id/return`

Request body: `{"reason":"Please clarify the affected area and expected timing."}`

The reason is mandatory (5–1000 characters). The creator cannot return their own warning. A successful return moves the warning from `pending` back to `draft`, clears any approval attribution, and appends a `returned_to_author` audit event containing the reviewer feedback. The author can then edit and resubmit the draft for a fresh independent review. The endpoint does not publish or distribute the warning.
## Edit a draft warning

The original forecaster (or an administrator) can edit a warning while its workflow is `draft`, including after a reviewer returns it for correction:

`PATCH /api/alerts/:id`

Example body: `{"headline":"Updated warning headline","description":"Revised impact and affected area.","instruction":"Follow local authority guidance."}`

Only recognized CAP alert fields are updated. CAP validation is applied to supplied values, and an audit event records the names of changed fields. Editing is rejected for pending, approved, published or cancelled warnings. Reviewers cannot edit another users draft; they must return it with a reason and let its author make corrections.