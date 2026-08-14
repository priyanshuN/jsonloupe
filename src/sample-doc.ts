// Copyright (c) 2026 Priyanshu Nandan
// SPDX-License-Identifier: MIT
// The sample is the first thing a visitor with no file of their own can click,
// so it is the one document that has to argue for the whole tool in ten
// seconds: an order export with its line items nested inside it, which the
// converter turns into two linked sheets rather than items/0/sku columns;
// two order ids past the point where a spreadsheet keeps every digit — they
// differ by one, and a float lands both on the same value, so Excel would merge
// two different orders; prices written with the trailing zero a money column
// needs; and a rate carrying more digits than a float can hold.
//
// It is source text rather than an object handed to JSON.stringify because
// JavaScript's own numbers would flatten every one of those values before the
// sample ever reached the parser: the two ids would arrive already equal and
// 1.10 would arrive as 1.1. Written as text, what the file says is what the
// viewer reads.
export const SAMPLE_DOC_TITLE = 'sample-orders.json';

export const SAMPLE_DOC = `{
  "exportedAt": "2026-08-05T09:12:00Z",
  "currency": "GBP",
  "orders": [
    {
      "orderId": 7241590238164561921,
      "reference": "SO-10428",
      "placedAt": "2026-08-04 14:22:10",
      "status": "shipped",
      "customer": { "name": "Ash Fielding", "city": "Bristol" },
      "tags": ["gift", "priority"],
      "fxRateAtCapture": 1.27384516789012345678,
      "total": 41.30,
      "items": [
        { "sku": "TSHIRT-BLK-M", "description": "cotton t-shirt", "qty": 3, "unitPrice": 1.10, "lineTotal": 3.30 },
        { "sku": "MUG-CER-01", "description": "ceramic mug", "qty": 2, "unitPrice": 19.00, "lineTotal": 38.00 }
      ],
      "gatewayResponse": "{\\"authCode\\":\\"A1042\\",\\"avs\\":\\"Y\\"}"
    },
    {
      "orderId": 7241590238164561922,
      "reference": "SO-10429",
      "placedAt": "2026-08-04 16:05:41",
      "status": "packing",
      "customer": { "name": "Dana Okoro", "city": "Leeds" },
      "tags": [],
      "fxRateAtCapture": 1.27401234567890123456,
      "total": 12.75,
      "items": [
        { "sku": "MUG-CER-01", "description": "ceramic mug", "qty": 1, "unitPrice": 12.75, "lineTotal": 12.75 }
      ],
      "gatewayResponse": null
    }
  ]
}
`;

// The landing's scale claim ("five-million-element arrays open instantly"),
// made experienceable: nothing a first visit can click proves it, because no
// first visit has a 35 MB file handy. This builds one locally — a flat sensor
// trace whose one int64 id keeps the lossless story in frame — and hands it to
// the same open path a paste takes, so what opens is exactly what any real
// document goes through. Text, not objects, for the same reason as above.
//
// Deterministic on purpose: a seeded LCG, no Date/Math.random, so every visitor
// opens byte-identical output and a bug report about row 3,401,882 reproduces.
// The builder yields between chunks to keep the page interactive while ~35 MB
// of text accumulates; the caller owns whatever progress it wants to show.
export const LARGE_SAMPLE_TITLE = 'five-million-readings.json';
export const LARGE_SAMPLE_ELEMENTS = 5_000_000;

export async function buildLargeSample(
  elements: number = LARGE_SAMPLE_ELEMENTS,
  onChunk?: (done: number, total: number) => void,
): Promise<string> {
  const CHUNK = 250_000;
  const parts: string[] = [
    '{\n' +
      '  "instrument": "flux sensor 7 — synthetic trace, built in this tab",\n' +
      '  "sensorId": 9007199254740993,\n' +
      '  "unit": "uV",\n' +
      '  "readings": [',
  ];
  let seed = 0x2545f491;
  const nums: string[] = new Array(Math.min(CHUNK, elements));
  for (let done = 0; done < elements; ) {
    const n = Math.min(CHUNK, elements - done);
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      nums[i] = String(seed % 1_000_000);
    }
    parts.push((done === 0 ? '' : ',') + (n === nums.length ? nums : nums.slice(0, n)).join(','));
    done += n;
    onChunk?.(done, elements);
    // Yield the main thread between chunks; the paste card stays responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  parts.push(']\n}\n');
  return parts.join('');
}
