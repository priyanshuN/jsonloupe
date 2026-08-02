// The validation corpus (SPEC-converter.md §6): eight hand-written converters
// accumulated over ~2 years of routing work, each expressed as a spec and run
// through the engine.
//
// The gaps are `it.skip`, not silence. Each skipped test asserts the behaviour
// v2's frozen-transform block (§10.3) will provide, so landing it is a
// one-line un-skip and an immediate red→green.

import { describe, it, expect } from 'vitest';
import { convert, memorySink, type ConvertSpec } from './index';
import type { SourceInput } from './engine';

const NOW = new Date(2026, 7, 3); // 2026-08-03

async function rows(input: SourceInput, spec: ConvertSpec, name: string) {
  const sink = memorySink();
  const report = await convert(input, spec, sink, { now: NOW });
  return { rows: sink.byName(name)!.rows, cols: sink.byName(name)!.columns, report };
}

const FE_TAIL = [
  { name: 'PhoneNumber', const: '1122333' },
  { name: 'city$Routing Pickup', const: 'US' },
  { name: 'branch$Routing Pickup', const: 'US1' },
];

// ------------------------------------------------- 1. problem json → fe orders

describe('convert_problem_json_to_fareye_orders', () => {
  const doc = {
    problems: [
      {
        jobs: [
          { orderId: 998811, lat: 28.53, lng: 77.39, weight: 12, groupId: 'G1', serviceTime: 5, startTime: '09:00', endTime: '18:00', jobPriority: 1 },
          { lat: 1, lng: 2 }, // no orderId — the Python `continue`s
        ],
      },
    ],
  };

  const spec: ConvertSpec = {
    specVersion: 1,
    source: { format: 'json' },
    output: { format: 'xlsx' },
    tables: [{
      name: 'orders',
      anchor: '$.problems[].jobs[]',
      columns: [
        { name: 'reference_number', from: 'orderId', skipRowIfMissing: true },
        { name: 'Name', from: 'orderId' },
        { name: 'LatnLongLatitude', from: 'lat' },
        { name: 'LatnLongLongitude', from: 'lng' },
        { name: 'Address', from: 'orderId' },
        { name: 'weigh', from: 'weight' },
        { name: 'GrpID', from: 'groupId' },
        { name: 'DeliveryServiceTime', from: 'serviceTime' },
        { name: 'DeliveryStartTime', from: 'startTime', type: 'datetime', parse: 'HH:mm', baseDate: 'today', out: 'yyyy-MM-dd HH:mm:ss' },
        { name: 'DeliveryEndTime', from: 'endTime', type: 'datetime', parse: 'HH:mm', baseDate: 'today', out: 'yyyy-MM-dd HH:mm:ss' },
        { name: 'JobPriority', from: 'jobPriority' },
        ...FE_TAIL,
      ],
    }],
  };

  it('walks nested arrays, stamps today onto HH:mm, and drops the row with no orderId', async () => {
    const r = await rows({ doc }, spec, 'orders');
    expect(r.rows).toHaveLength(1);
    expect(r.report.tables[0].skipped).toBe(1);
    expect(r.rows[0]).toEqual([
      '998811', '998811', '28.53', '77.39', '998811', '12', 'G1', '5',
      '2026-08-03 09:00:00', '2026-08-03 18:00:00', '1',
      '1122333', 'US', 'US1',
    ]);
  });

  it.skip('GAP: reference_number carries a `_1` suffix (v2 frozen transform)', async () => {
    const withSuffix = JSON.parse(JSON.stringify(spec));
    withSuffix.tables[0].columns[0].transform = { js: "v => v + '_1'" };
    const r = await rows({ doc }, withSuffix, 'orders');
    expect(r.rows[0][0]).toBe('998811_1');
  });
});

// ----------------------------------------------------- 2. DHL maps → fe orders

describe('convert_dhl_json_to_fareye_orders', () => {
  const doc = {
    hubIdClusteringRequestMap: {
      '23': {
        dispatchDate: '2026-08-01 00:00:00',
        hubCode: 'ND1',
        fenceIdProblemMap: {
          '203297': {
            jobIdMap: {
              'J-1': { orderId: 998811, lat: 28.53, lng: 77.39, weight: 12, groupId: 'G1', serviceTime: 5, parsedStartTime: 540, parsedEndTime: 1080, jobPriority: 1 },
              'J-2': { lat: 0, lng: 0 },
            },
          },
        },
      },
    },
  };

  const spec: ConvertSpec = {
    specVersion: 1,
    source: { format: 'json' },
    output: { format: 'xlsx' },
    tables: [{
      name: 'orders',
      anchor: '$.hubIdClusteringRequestMap{}.fenceIdProblemMap{}.jobIdMap{}',
      columns: [
        { name: 'reference_number', from: 'orderId', skipRowIfMissing: true },
        { name: 'hub_id', from: '^^.{key}' },
        { name: 'branch$Routing Pickup', from: '^^.hubCode' },
        { name: 'LatnLongLatitude', from: 'lat' },
        { name: 'LatnLongLongitude', from: 'lng' },
        { name: 'DeliveryStartTime', from: 'parsedStartTime', type: 'datetime', parse: 'minutesOfDay', baseDate: '^^.dispatchDate', out: 'yyyy-MM-dd HH:mm:ss' },
        { name: 'DeliveryEndTime', from: 'parsedEndTime', type: 'datetime', parse: 'minutesOfDay', baseDate: '^^.dispatchDate', out: 'yyyy-MM-dd HH:mm:ss' },
      ],
    }],
  };

  it('iterates three levels of maps and dates minutes-of-day off the grandparent', async () => {
    const r = await rows({ doc }, spec, 'orders');
    expect(r.rows).toEqual([[
      '998811', '23', 'ND1', '28.53', '77.39',
      '2026-08-01 09:00:00', '2026-08-01 18:00:00',
    ]]);
  });

  it('reaches the map key the hand-written loop discarded', async () => {
    const r = await rows({ doc }, spec, 'orders');
    expect(r.cols[1]).toBe('hub_id');
    expect(r.rows[0][1]).toBe('23');
  });

  it('falls back to today when the ancestor date is unreadable, and says so', async () => {
    const broken = JSON.parse(JSON.stringify(doc));
    broken.hubIdClusteringRequestMap['23'].dispatchDate = 'not a date';
    const r = await rows({ doc: broken }, spec, 'orders');
    expect(r.rows[0][5]).toBe('2026-08-03 09:00:00');
    expect(r.report.warnings.map((w) => w.code)).toContain('BAD_BASEDATE');
  });
});

// ------------------------------------------------ 3. route orders → report csv

describe('convert_route_orders_to_report', () => {
  const csv = [
    'Reference No,Job LatLng,Slot,Weight,Group Id,Service Time',
    'R1,Lat: 28.53 Lng: 77.39,09:00 - 17:00,12,G1,5',
  ].join('\n');

  const spec: ConvertSpec = {
    specVersion: 1,
    source: { format: 'csv' },
    output: { format: 'xlsx' },
    tables: [{
      name: 'report',
      anchor: '$[]',
      columns: [
        { name: 'reference_number', from: 'Reference No' },
        { name: 'destination_latitude', from: 'Job LatLng', type: 'geo', part: 'lat' },
        { name: 'destination_longitude', from: 'Job LatLng', type: 'geo', part: 'lng' },
        { name: 'item_weight', from: 'Weight' },
        { name: 'stop_id*', from: 'Group Id' },
        { name: 'order_service_time', from: 'Service Time' },
      ],
    }],
  };

  it('unpacks a labelled coordinate into two columns', async () => {
    const r = await rows({ text: csv, format: 'csv' }, spec, 'report');
    expect(r.rows).toEqual([['R1', '28.53', '77.39', '12', 'G1', '5']]);
  });

  it.skip('GAP: the Slot column splits into start and end (v2 frozen transform)', async () => {
    const withSplit = JSON.parse(JSON.stringify(spec));
    withSplit.tables[0].columns.push(
      { name: 'destination_start_time', from: 'Slot', transform: { js: "v => v.split('-')[0].trim()" } },
      { name: 'destination_end_time', from: 'Slot', transform: { js: "v => v.split('-')[1].trim()" } },
    );
    const r = await rows({ text: csv, format: 'csv' }, withSplit, 'report');
    expect(r.rows[0].slice(-2)).toEqual(['09:00', '17:00']);
  });
});

// ------------------------------------------------- 4. fe orders → report orders

describe('convert_fe_orders_to_report_orders', () => {
  const csv = [
    'reference_number*,LatnLongLatitude,LatnLongLongitude,DeliveryStartTime,DeliveryEndTime,volume,GrpID,DeliveryServiceTime',
    'R1,28.53,77.39,2026-08-01 09:00:00,2026-08-01 17:30:00,1.5,,5',
  ].join('\n');

  const spec: ConvertSpec = {
    specVersion: 1,
    source: { format: 'csv' },
    output: { format: 'xlsx', onMissing: '' },
    tables: [{
      name: 'report',
      anchor: '$[]',
      columns: [
        { name: 'reference_number', from: 'reference_number*' },
        { name: 'destination_latitude', from: 'LatnLongLatitude' },
        { name: 'destination_longitude', from: 'LatnLongLongitude' },
        { name: 'destination_start_time', from: 'DeliveryStartTime', type: 'datetime', parse: 'yyyy-MM-dd HH:mm:ss', out: 'HH:mm' },
        { name: 'destination_end_time', from: 'DeliveryEndTime', type: 'datetime', parse: 'yyyy-MM-dd HH:mm:ss', out: 'HH:mm' },
        { name: 'stop_id*', from: 'GrpID' },
        { name: 'order_service_time', from: 'DeliveryServiceTime' },
      ],
    }],
  };

  it('extracts HH:mm out of a full timestamp and blanks the empty column', async () => {
    const r = await rows({ text: csv, format: 'csv' }, spec, 'report');
    expect(r.rows).toEqual([['R1', '28.53', '77.39', '09:00', '17:30', '', '5']]);
  });

  it.skip('GAP: item_weight is volume × 1000 (v2 frozen transform)', async () => {
    const withScale = JSON.parse(JSON.stringify(spec));
    withScale.tables[0].columns.push({ name: 'item_weight', from: 'volume', transform: { js: 'v => Number(v) * 1000' } });
    const r = await rows({ text: csv, format: 'csv' }, withScale, 'report');
    expect(r.rows[0].at(-1)).toBe('1500');
  });
});

// -------------------------------------------------- 5. report → fe orders (csv)

describe('convert_report_to_fareye_orders', () => {
  const csv = [
    'reference_number,destination_latitude,destination_longitude,item_weight,order_service_time,destination_start_time,destination_end_time',
    'R1,28.53,77.39,12,5,09:00,17:00',
  ].join('\n');

  const spec: ConvertSpec = {
    specVersion: 1,
    source: { format: 'csv' },
    output: { format: 'xlsx' },
    tables: [{
      name: 'orders',
      anchor: '$[]',
      columns: [
        { name: 'Name', from: 'reference_number' },
        { name: 'LatnLongLatitude', from: 'destination_latitude' },
        { name: 'LatnLongLongitude', from: 'destination_longitude' },
        { name: 'weigh', from: 'item_weight' },
        { name: 'DeliveryServiceTime', from: 'order_service_time' },
        { name: 'DeliveryStartTime', from: 'destination_start_time', type: 'datetime', parse: 'HH:mm', baseDate: 'today', out: 'yyyy-MM-dd HH:mm:ss' },
        { name: 'DeliveryEndTime', from: 'destination_end_time', type: 'datetime', parse: 'HH:mm', baseDate: 'today', out: 'yyyy-MM-dd HH:mm:ss' },
        ...FE_TAIL,
      ],
    }],
  };

  it('stamps today onto the slot times and carries the literals', async () => {
    const r = await rows({ text: csv, format: 'csv' }, spec, 'orders');
    expect(r.rows).toEqual([[
      'R1', '28.53', '77.39', '12', '5',
      '2026-08-03 09:00:00', '2026-08-03 17:00:00',
      '1122333', 'US', 'US1',
    ]]);
  });
});

// ------------------------------------------ 6. labelled orders → logistic orders

describe('convert_labelled_orders_logistic_orders', () => {
  const csv = [
    'reference_number,destination_latitude,destination_longitude,item_weight,order_service_time',
    'R1,28.53,77.39,12,5',
    'R2,28.60,77.20,8,4',
  ].join('\n');

  const spec: ConvertSpec = {
    specVersion: 1,
    source: { format: 'csv' },
    output: { format: 'xlsx' },
    tables: [{
      name: 'logistic',
      anchor: '$[]',
      columns: [
        { name: 'reference_number', from: 'reference_number' },
        { name: 'pickup_latitude', const: '-23.5174827910248' },
        { name: 'pickup_longitude', const: '-46.6698253154755' },
        { name: 'last_mile_latitude', from: 'destination_latitude' },
        { name: 'last_mile_longitude', from: 'destination_longitude' },
        { name: 'volume', const: '0' },
        { name: 'weight', from: 'item_weight' },
        { name: 'job_priority', const: '0' },
        { name: 'service_time', from: 'order_service_time' },
        { name: 'new_shipping_date_time', const: '29/01/2025' },
      ],
    }],
  };

  it('is almost entirely literals, which the format takes without a transform', async () => {
    const r = await rows({ text: csv, format: 'csv' }, spec, 'logistic');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toEqual([
      'R1', '-23.5174827910248', '-46.6698253154755', '28.53', '77.39',
      '0', '12', '0', '5', '29/01/2025',
    ]);
  });

  it.skip('GAP: rows are de-duplicated on stop_id (needs a row-level operator, not a transform)', async () => {
    const dupes = `${csv}\nR3,28.60,77.20,8,4`;
    const r = await rows({ text: dupes, format: 'csv' }, spec, 'logistic');
    expect(r.rows).toHaveLength(2);
  });
});

// ------------------------------------------------------------ 7. rename_headers

describe('rename_headers', () => {
  it('is a pure header remap — CSV to CSV falls out of the same machinery', async () => {
    const csv = [
      'reference_number*,destination_latitude*,destination_longitude*,location zip code',
      'R1,28.53,77.39,110001',
    ].join('\n');
    const spec: ConvertSpec = {
      specVersion: 1,
      source: { format: 'csv' },
      output: { format: 'csv' },
      tables: [{
        name: 'renamed',
        anchor: '$[]',
        columns: [
          { name: 'reference_number', from: 'reference_number*' },
          { name: 'destination_latitude', from: 'destination_latitude*' },
          { name: 'destination_longitude', from: 'destination_longitude*' },
          { name: 'Zip Code', from: 'location zip code' },
        ],
      }],
    };
    const r = await rows({ text: csv, format: 'csv' }, spec, 'renamed');
    expect(r.cols).toEqual(['reference_number', 'destination_latitude', 'destination_longitude', 'Zip Code']);
    expect(r.rows).toEqual([['R1', '28.53', '77.39', '110001']]);
  });
});

// ----------------------------------------------------------- 8. process_headers

describe('process_headers', () => {
  const csv = [
    'location stop time,destination_start_time*,destination_end_time*,volume',
    '01:30:00,09:00:00,17:00:00,"1,5"',
  ].join('\n');

  const spec: ConvertSpec = {
    specVersion: 1,
    source: { format: 'csv' },
    output: { format: 'xlsx' },
    tables: [{
      name: 'processed',
      anchor: '$[]',
      columns: [
        { name: 'order_service_time', from: 'location stop time', type: 'datetime', parse: 'HH:mm:ss', out: 'minutesOfDay' },
        { name: 'destination_start_time*', from: 'destination_start_time*', type: 'datetime', parse: 'HH:mm:ss', out: 'HH:mm' },
        { name: 'destination_end_time*', from: 'destination_end_time*', type: 'datetime', parse: 'HH:mm:ss', out: 'HH:mm' },
      ],
    }],
  };

  it('converts a duration to minutes and truncates the slot times', async () => {
    const r = await rows({ text: csv, format: 'csv' }, spec, 'processed');
    expect(r.rows).toEqual([['90', '09:00', '17:00']]);
  });

  it.skip('GAP: item_weight is comma-decimal volume × 1000 (v2 frozen transform)', async () => {
    const withScale = JSON.parse(JSON.stringify(spec));
    withScale.tables[0].columns.push({
      name: 'item_weight', from: 'volume',
      transform: { js: "v => Math.round(parseFloat(String(v).replace(',', '.')) * 1000)" },
    });
    const r = await rows({ text: csv, format: 'csv' }, withScale, 'processed');
    expect(r.rows[0].at(-1)).toBe('1500');
  });
});
