import {
  flattenedKeyToSqlExpression,
  isDenylisted,
  isHighCardinality,
  isIdField,
  isTimestampArrayField,
} from '../DBDeltaChart';

const traceColumnMeta = [
  { name: 'Timestamp', type: 'DateTime64(9)' },
  { name: 'TraceId', type: 'String' },
  { name: 'SpanId', type: 'String' },
  { name: 'ParentSpanId', type: 'String' },
  { name: 'ResourceAttributes', type: 'Map(String, String)' },
  { name: 'SpanAttributes', type: 'Map(String, String)' },
  { name: 'Events.Timestamp', type: 'Array(DateTime64(9))' },
  { name: 'Events.Name', type: 'Array(String)' },
  { name: 'Events.Attributes', type: 'Array(Map(String, String))' },
  { name: 'Links.TraceId', type: 'Array(String)' },
  { name: 'Links.SpanId', type: 'Array(String)' },
  { name: 'Links.Timestamp', type: 'Array(DateTime64(9))' },
  { name: 'Links.Attributes', type: 'Array(Map(String, String))' },
];

describe('flattenedKeyToSqlExpression', () => {
  it('converts Map column dot-notation to bracket notation', () => {
    expect(
      flattenedKeyToSqlExpression('ResourceAttributes.service.name', traceColumnMeta),
    ).toBe("ResourceAttributes['service.name']");
  });

  it('converts SpanAttributes dot-notation to bracket notation', () => {
    expect(
      flattenedKeyToSqlExpression('SpanAttributes.http.method', traceColumnMeta),
    ).toBe("SpanAttributes['http.method']");
  });

  it('converts Array(Map) dot-notation with 0-based index to 1-based bracket notation', () => {
    expect(
      flattenedKeyToSqlExpression('Events.Attributes[0].message.type', traceColumnMeta),
    ).toBe("Events.Attributes[1]['message.type']");
  });

  it('increments the array index from 0-based JS to 1-based ClickHouse', () => {
    expect(
      flattenedKeyToSqlExpression('Events.Attributes[4].key', traceColumnMeta),
    ).toBe("Events.Attributes[5]['key']");
  });

  it('handles Links.Attributes Array(Map) correctly', () => {
    expect(
      flattenedKeyToSqlExpression('Links.Attributes[0].some.key', traceColumnMeta),
    ).toBe("Links.Attributes[1]['some.key']");
  });

  it('returns simple columns unchanged', () => {
    expect(
      flattenedKeyToSqlExpression('TraceId', traceColumnMeta),
    ).toBe('TraceId');
  });

  it('returns non-map nested columns unchanged (e.g., Arrays of primitives)', () => {
    expect(
      flattenedKeyToSqlExpression('Events.Name[0]', traceColumnMeta),
    ).toBe('Events.Name[0]');
  });

  it('returns key unchanged when no matching column found', () => {
    expect(
      flattenedKeyToSqlExpression('SomeUnknownColumn.key', traceColumnMeta),
    ).toBe('SomeUnknownColumn.key');
  });

  it('handles LowCardinality(Map) wrapped types', () => {
    const meta = [
      { name: 'LogAttributes', type: 'LowCardinality(Map(String, String))' },
    ];
    expect(
      flattenedKeyToSqlExpression('LogAttributes.level', meta),
    ).toBe("LogAttributes['level']");
  });

  it('handles Nullable(Map) wrapped types', () => {
    const meta = [{ name: 'Attrs', type: 'Nullable(Map(String, String))' }];
    expect(
      flattenedKeyToSqlExpression('Attrs.some.key', meta),
    ).toBe("Attrs['some.key']");
  });

  it('returns key unchanged for empty columnMeta', () => {
    expect(flattenedKeyToSqlExpression('ResourceAttributes.service.name', [])).toBe(
      'ResourceAttributes.service.name',
    );
  });
});

describe('isIdField', () => {
  it('identifies top-level String columns ending in Id', () => {
    expect(isIdField('TraceId', traceColumnMeta)).toBe(true);
    expect(isIdField('SpanId', traceColumnMeta)).toBe(true);
    expect(isIdField('ParentSpanId', traceColumnMeta)).toBe(true);
  });

  it('identifies Array(String) column elements whose name ends in Id', () => {
    expect(isIdField('Links.TraceId[0]', traceColumnMeta)).toBe(true);
    expect(isIdField('Links.SpanId[0]', traceColumnMeta)).toBe(true);
    expect(isIdField('Links.TraceId[5]', traceColumnMeta)).toBe(true);
  });

  it('identifies plain Array(String) column reference ending in Id', () => {
    expect(isIdField('Links.TraceId', traceColumnMeta)).toBe(true);
    expect(isIdField('Links.SpanId', traceColumnMeta)).toBe(true);
  });

  it('does not match non-ID String columns', () => {
    expect(isIdField('Timestamp', traceColumnMeta)).toBe(false);
    expect(isIdField('Events.Name[0]', traceColumnMeta)).toBe(false);
  });

  it('does not match Map or Array(Map) columns even if name ends in Id', () => {
    const meta = [{ name: 'MyMapId', type: 'Map(String, String)' }];
    expect(isIdField('MyMapId', meta)).toBe(false);
  });

  it('does not match keys with sub-keys after array index (Array(Map) paths)', () => {
    expect(isIdField('Events.Attributes[0].spanId', traceColumnMeta)).toBe(false);
  });

  it('returns false for unknown columns', () => {
    expect(isIdField('UnknownId', traceColumnMeta)).toBe(false);
  });

  it('returns false for empty columnMeta', () => {
    expect(isIdField('TraceId', [])).toBe(false);
  });
});

describe('isTimestampArrayField', () => {
  it('identifies Array(DateTime64) column elements by index', () => {
    expect(isTimestampArrayField('Events.Timestamp[0]', traceColumnMeta)).toBe(true);
    expect(isTimestampArrayField('Events.Timestamp[23]', traceColumnMeta)).toBe(true);
    expect(isTimestampArrayField('Links.Timestamp[0]', traceColumnMeta)).toBe(true);
  });

  it('identifies plain Array(DateTime64) column reference', () => {
    expect(isTimestampArrayField('Events.Timestamp', traceColumnMeta)).toBe(true);
    expect(isTimestampArrayField('Links.Timestamp', traceColumnMeta)).toBe(true);
  });

  it('does not match non-DateTime64 array columns', () => {
    expect(isTimestampArrayField('Events.Name[0]', traceColumnMeta)).toBe(false);
    expect(isTimestampArrayField('Links.TraceId[0]', traceColumnMeta)).toBe(false);
    expect(isTimestampArrayField('Events.Attributes[0]', traceColumnMeta)).toBe(false);
  });

  it('does not match non-array DateTime64 columns', () => {
    expect(isTimestampArrayField('Timestamp', traceColumnMeta)).toBe(false);
  });

  it('does not match Array(Map) sub-key paths', () => {
    expect(isTimestampArrayField('Events.Attributes[0].timestamp', traceColumnMeta)).toBe(false);
  });

  it('returns false for unknown columns', () => {
    expect(isTimestampArrayField('Unknown.Timestamp[0]', traceColumnMeta)).toBe(false);
  });

  it('handles Array(DateTime64) with timezone parameter', () => {
    const meta = [{ name: 'MyTimestamps', type: "Array(DateTime64(9, 'UTC'))" }];
    expect(isTimestampArrayField('MyTimestamps[0]', meta)).toBe(true);
  });
});

describe('isDenylisted', () => {
  it('denylists ID fields', () => {
    expect(isDenylisted('TraceId', traceColumnMeta)).toBe(true);
    expect(isDenylisted('SpanId', traceColumnMeta)).toBe(true);
    expect(isDenylisted('ParentSpanId', traceColumnMeta)).toBe(true);
    expect(isDenylisted('Links.TraceId[0]', traceColumnMeta)).toBe(true);
  });

  it('denylists timestamp array fields', () => {
    expect(isDenylisted('Events.Timestamp[0]', traceColumnMeta)).toBe(true);
    expect(isDenylisted('Links.Timestamp[3]', traceColumnMeta)).toBe(true);
  });

  it('does not denylist useful fields', () => {
    expect(isDenylisted('ResourceAttributes.service.name', traceColumnMeta)).toBe(false);
    expect(isDenylisted('SpanAttributes.http.method', traceColumnMeta)).toBe(false);
    expect(isDenylisted('Events.Name[0]', traceColumnMeta)).toBe(false);
  });
});

describe('isHighCardinality', () => {
  it('identifies high cardinality fields (all unique values)', () => {
    // 1000 unique values out of 1000 total occurrences
    const outlierValues = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      outlierValues.set(`value-${i}`, 0.1);
    }
    const outlierValueOccurences = new Map([['TraceId', outlierValues]]);
    const outlierPropertyOccurences = new Map([['TraceId', 1000]]);

    expect(
      isHighCardinality(
        'TraceId',
        outlierValueOccurences,
        new Map(),
        outlierPropertyOccurences,
        new Map(),
      ),
    ).toBe(true);
  });

  it('keeps low cardinality fields visible (few distinct values)', () => {
    const outlierValues = new Map([['GET', 80], ['POST', 20]]);
    const outlierValueOccurences = new Map([['http.method', outlierValues]]);
    const outlierPropertyOccurences = new Map([['http.method', 1000]]);

    expect(
      isHighCardinality(
        'http.method',
        outlierValueOccurences,
        new Map(),
        outlierPropertyOccurences,
        new Map(),
      ),
    ).toBe(false);
  });

  it('uses min of both groups — keeps visible if either group has low cardinality', () => {
    // Outliers: 2 unique values (low cardinality)
    const outlierValues = new Map([['GET', 80], ['POST', 20]]);
    const outlierValueOccurences = new Map([['method', outlierValues]]);
    const outlierPropertyOccurences = new Map([['method', 1000]]);

    // Inliers: 500 unique values (high cardinality)
    const inlierValues = new Map<string, number>();
    for (let i = 0; i < 500; i++) inlierValues.set(`v${i}`, 0.2);
    const inlierValueOccurences = new Map([['method', inlierValues]]);
    const inlierPropertyOccurences = new Map([['method', 500]]);

    // outlierUniqueness = 2/1000 = 0.002, inlierUniqueness = 500/500 = 1.0
    // min = 0.002 < 0.9 → field is visible
    expect(
      isHighCardinality(
        'method',
        outlierValueOccurences,
        inlierValueOccurences,
        outlierPropertyOccurences,
        inlierPropertyOccurences,
      ),
    ).toBe(false);
  });

  it('hides field when BOTH groups have high cardinality', () => {
    const makeHighCardinalityMap = (n: number) => {
      const m = new Map<string, number>();
      for (let i = 0; i < n; i++) m.set(`v${i}`, 100 / n);
      return m;
    };

    const outlierValues = makeHighCardinalityMap(500);
    const inlierValues = makeHighCardinalityMap(400);
    const outlierValueOccurences = new Map([['url', outlierValues]]);
    const inlierValueOccurences = new Map([['url', inlierValues]]);
    const outlierPropertyOccurences = new Map([['url', 500]]);
    const inlierPropertyOccurences = new Map([['url', 400]]);

    // min(500/500, 400/400) = 1.0 > 0.9 → hidden
    expect(
      isHighCardinality(
        'url',
        outlierValueOccurences,
        inlierValueOccurences,
        outlierPropertyOccurences,
        inlierPropertyOccurences,
      ),
    ).toBe(true);
  });

  it('keeps visible when combined sample size is <= 20', () => {
    const outlierValues = new Map<string, number>();
    for (let i = 0; i < 10; i++) outlierValues.set(`v${i}`, 10);
    const outlierValueOccurences = new Map([['field', outlierValues]]);
    const outlierPropertyOccurences = new Map([['field', 10]]);
    const inlierPropertyOccurences = new Map([['field', 10]]);

    // combined = 10 + 10 = 20, threshold is > 20
    expect(
      isHighCardinality(
        'field',
        outlierValueOccurences,
        new Map(),
        outlierPropertyOccurences,
        inlierPropertyOccurences,
      ),
    ).toBe(false);
  });

  it('uses single group uniqueness when other group has no data', () => {
    // Only outlier data, high cardinality
    const outlierValues = new Map<string, number>();
    for (let i = 0; i < 100; i++) outlierValues.set(`v${i}`, 1);
    const outlierValueOccurences = new Map([['id', outlierValues]]);
    const outlierPropertyOccurences = new Map([['id', 100]]);

    expect(
      isHighCardinality(
        'id',
        outlierValueOccurences,
        new Map(),
        outlierPropertyOccurences,
        new Map(),
      ),
    ).toBe(true);
  });

  it('returns false for field not present in either group', () => {
    expect(
      isHighCardinality(
        'unknownField',
        new Map(),
        new Map(),
        new Map(),
        new Map(),
      ),
    ).toBe(false);
  });
});

describe('field split logic (visible vs hidden)', () => {
  it('correctly classifies a mix of ID, timestamp, cardinality, and useful fields', () => {
    // TraceId → denylist (ID field, String)
    expect(isDenylisted('TraceId', traceColumnMeta)).toBe(true);

    // Events.Timestamp[0] → denylist (timestamp array)
    expect(isDenylisted('Events.Timestamp[0]', traceColumnMeta)).toBe(true);

    // ResourceAttributes.service.name → not denylisted
    expect(isDenylisted('ResourceAttributes.service.name', traceColumnMeta)).toBe(false);

    // High cardinality field with 1000 unique values in 1000 rows → hidden
    const hcValues = new Map<string, number>();
    for (let i = 0; i < 1000; i++) hcValues.set(`trace-${i}`, 0.1);
    expect(
      isHighCardinality(
        'trace.id',
        new Map([['trace.id', hcValues]]),
        new Map(),
        new Map([['trace.id', 1000]]),
        new Map(),
      ),
    ).toBe(true);

    // Low cardinality field → visible
    const lcValues = new Map([['production', 70], ['staging', 30]]);
    expect(
      isHighCardinality(
        'deployment.env',
        new Map([['deployment.env', lcValues]]),
        new Map(),
        new Map([['deployment.env', 1000]]),
        new Map(),
      ),
    ).toBe(false);
  });
});
