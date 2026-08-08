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
