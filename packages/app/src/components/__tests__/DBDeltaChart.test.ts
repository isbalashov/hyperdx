import { flattenedKeyToSqlExpression } from '../DBDeltaChart';

describe('flattenedKeyToSqlExpression', () => {
  const traceColumnMeta = [
    { name: 'Timestamp', type: 'DateTime64(9)' },
    { name: 'TraceId', type: 'String' },
    { name: 'ResourceAttributes', type: 'Map(String, String)' },
    { name: 'SpanAttributes', type: 'Map(String, String)' },
    { name: 'Events.Timestamp', type: 'Array(DateTime64(9))' },
    { name: 'Events.Name', type: 'Array(String)' },
    { name: 'Events.Attributes', type: 'Array(Map(String, String))' },
    { name: 'Links.Attributes', type: 'Array(Map(String, String))' },
  ];

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
