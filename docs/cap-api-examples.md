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

## Supported structured fields

- Multiple `info_blocks` with language tags.
- Multiple categories and response types per information block.
- Multiple affected areas, polygons, circles and geocodes.
- Altitude and ceiling.
- Supplemental resources with description, MIME type, size, URI, dereferenced URI and digest.
- Parameters, sender name, web URL, contact, and references.
- Update and Cancel message drafts linked to a previous alert.

The API's structured payload is ahead of the current dashboard form; multilingual entry is currently available through the API. A visual multilingual editor and map-drawing UI remain future work.
