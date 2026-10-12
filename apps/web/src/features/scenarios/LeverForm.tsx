import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LEVER_LABELS, LEVER_TYPES, type LeverType } from '@supplycast/shared';
import { inputCls } from '../../components/ui';
import { mdApi } from '../masterdata/api';

type Scope = 'ALL' | 'PRODUCT' | 'CATEGORY' | 'LOCATION';

/** Builds the lever JSON expected by the API from simple form fields. */
export function LeverForm({
  onSubmit,
  busy,
}: {
  onSubmit: (lever: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [type, setType] = useState<LeverType>('SUPPLIER_DELAY');
  const [scope, setScope] = useState<Scope>('ALL');
  const [targetId, setTargetId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [linkId, setLinkId] = useState('');
  const [percent, setPercent] = useState('10');
  const [extraDays, setExtraDays] = useState('14');
  const [leadTime, setLeadTime] = useState('28');
  const [capacity, setCapacity] = useState('100');
  const [service, setService] = useState('97');
  const [elasticity, setElasticity] = useState('1');
  const [startDate, setStart] = useState('');
  const [endDate, setEnd] = useState('');

  const products = useQuery({
    queryKey: ['products', 'all'],
    queryFn: () => mdApi.products('pageSize=100'),
  });
  const categories = useQuery({ queryKey: ['categories'], queryFn: mdApi.categories });
  const locations = useQuery({ queryKey: ['locations'], queryFn: mdApi.locations });
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: mdApi.suppliers });
  const links = useQuery({
    queryKey: ['supplier-products', supplierId],
    queryFn: () => mdApi.supplierProducts(supplierId),
    enabled: type === 'LEAD_TIME_CHANGE' && !!supplierId,
  });

  const dates = { ...(startDate && { startDate }), ...(endDate && { endDate }) };
  const needsScope = type === 'DEMAND_CHANGE' || type === 'PRICE_CHANGE';
  const needsSupplier =
    type === 'SUPPLIER_DELAY' || type === 'CAPACITY_CAP' || type === 'LEAD_TIME_CHANGE';
  const hasDates = type === 'DEMAND_CHANGE' || type === 'SUPPLIER_DELAY' || type === 'PRICE_CHANGE';
  const scopeTarget = scope === 'ALL' ? { scope } : { scope, id: targetId };

  function build(): Record<string, unknown> {
    switch (type) {
      case 'DEMAND_CHANGE':
        return { type, target: scopeTarget, params: { percent: Number(percent), ...dates } };
      case 'PRICE_CHANGE':
        return {
          type,
          target: scopeTarget,
          params: { percent: Number(percent), elasticity: Number(elasticity), ...dates },
        };
      case 'SUPPLIER_DELAY':
        return { type, target: { supplierId }, params: { extraDays: Number(extraDays), ...dates } };
      case 'LEAD_TIME_CHANGE':
        return {
          type,
          target: { supplierProductId: linkId },
          params: { leadTimeDays: Number(leadTime) },
        };
      case 'CAPACITY_CAP':
        return { type, target: { supplierId }, params: { weeklyQuantity: Number(capacity) } };
      case 'SERVICE_LEVEL':
        return { type, target: {}, params: { serviceLevel: Number(service) / 100 } };
    }
  }

  return (
    <form
      aria-label="Add lever"
      className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(build());
      }}
    >
      <label>
        Lever
        <select
          aria-label="Lever type"
          value={type}
          onChange={(e) => setType(e.target.value as LeverType)}
          className={inputCls}
        >
          {LEVER_TYPES.map((t) => (
            <option key={t} value={t}>
              {LEVER_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      {needsScope && (
        <>
          <label>
            Applies to
            <select
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as Scope);
                setTargetId('');
              }}
              className={inputCls}
            >
              <option value="ALL">Everything</option>
              <option value="PRODUCT">A product</option>
              <option value="CATEGORY">A category</option>
              <option value="LOCATION">A location</option>
            </select>
          </label>
          {scope !== 'ALL' && (
            <label>
              {scope === 'PRODUCT' ? 'Product' : scope === 'CATEGORY' ? 'Category' : 'Location'}
              <select
                required
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className={inputCls}
              >
                <option value="">Select…</option>
                {scope === 'PRODUCT' &&
                  products.data?.items.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku}
                    </option>
                  ))}
                {scope === 'CATEGORY' &&
                  categories.data?.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                {scope === 'LOCATION' &&
                  locations.data?.items.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </>
      )}
      {needsSupplier && (
        <label>
          Supplier
          <select
            required
            value={supplierId}
            onChange={(e) => {
              setSupplierId(e.target.value);
              setLinkId('');
            }}
            className={inputCls}
          >
            <option value="">Select…</option>
            {suppliers.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {type === 'LEAD_TIME_CHANGE' && (
        <>
          <label>
            Product
            <select
              required
              value={linkId}
              onChange={(e) => setLinkId(e.target.value)}
              className={inputCls}
            >
              <option value="">Select…</option>
              {links.data?.items.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.productSku}
                </option>
              ))}
            </select>
          </label>
          <label>
            New lead time (days)
            <input
              type="number"
              min={1}
              max={365}
              required
              value={leadTime}
              onChange={(e) => setLeadTime(e.target.value)}
              className={`${inputCls} w-24`}
            />
          </label>
        </>
      )}
      {(type === 'DEMAND_CHANGE' || type === 'PRICE_CHANGE') && (
        <label>
          Change (%)
          <input
            type="number"
            step="any"
            required
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            className={`${inputCls} w-24`}
          />
        </label>
      )}
      {type === 'PRICE_CHANGE' && (
        <label>
          Elasticity
          <input
            type="number"
            min={0}
            max={5}
            step="0.1"
            value={elasticity}
            onChange={(e) => setElasticity(e.target.value)}
            className={`${inputCls} w-20`}
          />
        </label>
      )}
      {type === 'SUPPLIER_DELAY' && (
        <label>
          Extra days late
          <input
            type="number"
            min={1}
            max={365}
            required
            value={extraDays}
            onChange={(e) => setExtraDays(e.target.value)}
            className={`${inputCls} w-24`}
          />
        </label>
      )}
      {type === 'CAPACITY_CAP' && (
        <label>
          Max units / week
          <input
            type="number"
            min={1}
            required
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            className={`${inputCls} w-28`}
          />
        </label>
      )}
      {type === 'SERVICE_LEVEL' && (
        <label>
          Target service level (%)
          <input
            type="number"
            min={50}
            max={99.9}
            step="0.1"
            required
            value={service}
            onChange={(e) => setService(e.target.value)}
            className={`${inputCls} w-24`}
          />
        </label>
      )}
      {hasDates && (
        <>
          <label>
            From
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStart(e.target.value)}
              className={inputCls}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEnd(e.target.value)}
              className={inputCls}
            />
          </label>
        </>
      )}
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-60"
      >
        Add lever
      </button>
    </form>
  );
}
