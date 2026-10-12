import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calls, json, loggedInAs, makeSub, makeUser, mockApi, page, renderApp } from './utils';

afterEach(() => vi.unstubAllGlobals());

const prod = (o: Record<string, unknown> = {}) => ({
  id: 'p1',
  sku: 'SKU-1',
  name: 'Widget',
  categoryId: 'c1',
  categoryName: 'Tools',
  unitCostCents: 250,
  unitPriceCents: 499,
  isComponent: false,
  isActive: true,
  ...o,
});
const cats = [
  { id: 'c1', name: 'Tools', parentId: null, productCount: 2 },
  { id: 'c2', name: 'Hand tools', parentId: 'c1', productCount: 1 },
];
const loc = { id: 'l1', code: 'WH-1', name: 'Main', type: 'WAREHOUSE' };

const base = (extra: Record<string, () => Promise<Response> | Response> = {}, me = makeUser()) => ({
  ...loggedInAs(me),
  'GET /billing/subscription': () => json(200, makeSub({ status: 'ACTIVE' })),
  'GET /categories': () => json(200, { items: cats }),
  ...extra,
});

describe('products page', () => {
  it('lists products, filters via query, and shows the empty state', async () => {
    const fetchMock = mockApi(
      base({
        'GET /products': () =>
          page([
            prod(),
            prod({ id: 'p2', sku: 'SKU-2', name: 'Gadget', isComponent: true, isActive: false }),
          ]),
      }),
    );
    renderApp('/products');
    expect(await screen.findByTestId('product-SKU-1')).toHaveTextContent('$2.50');
    expect(screen.getByTestId('product-SKU-2')).toHaveTextContent('component');
    expect(screen.getByTestId('product-SKU-2')).toHaveTextContent('Inactive');
    await userEvent.type(screen.getByLabelText('Search'), 'wid');
    await userEvent.selectOptions(screen.getByLabelText('Category'), 'c1');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'true');
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u]) =>
            String(u).includes('q=wid') &&
            String(u).includes('categoryId=c1') &&
            String(u).includes('isActive=true'),
        ),
      ).toBe(true),
    );
  });

  it('empty state', async () => {
    mockApi(base({ 'GET /products': () => page([]) }));
    renderApp('/products');
    expect(await screen.findByTestId('empty-products')).toBeInTheDocument();
  });

  it('creates a product with dollars converted to cents', async () => {
    const fetchMock = mockApi(
      base({
        'GET /products': () => page([]),
        'POST /products': () => json(201, { product: prod() }),
      }),
    );
    renderApp('/products');
    await userEvent.click(await screen.findByRole('button', { name: 'New product' }));
    const form = screen.getByRole('form', { name: 'New product' });
    await userEvent.type(within(form).getByLabelText('SKU'), 'NEW-1');
    await userEvent.type(within(form).getByLabelText('Name'), 'Thing');
    await userEvent.type(within(form).getByLabelText('Unit cost ($)'), '2.5');
    await userEvent.type(within(form).getByLabelText('Unit price ($)'), '4.99');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Product created');
    expect(JSON.parse(calls(fetchMock, 'POST /products')[0]![1]!.body as string)).toMatchObject({
      sku: 'NEW-1',
      name: 'Thing',
      unitCostCents: 250,
      unitPriceCents: 499,
      categoryId: null,
      isComponent: false,
    });
  });

  it('shows the plan-limit (402) and duplicate-SKU (409) messages from the server', async () => {
    let n = 0;
    mockApi(
      base({
        'GET /products': () => page([]),
        'POST /products': () =>
          ++n === 1
            ? json(402, {
                error: {
                  code: 'PLAN_LIMIT_REACHED',
                  message: 'Your plan allows 50 skus. Upgrade your plan to continue.',
                },
              })
            : json(409, {
                error: { code: 'SKU_EXISTS', message: 'A product with this SKU already exists' },
              }),
      }),
    );
    renderApp('/products');
    await userEvent.click(await screen.findByRole('button', { name: 'New product' }));
    const form = screen.getByRole('form', { name: 'New product' });
    await userEvent.type(within(form).getByLabelText('SKU'), 'X');
    await userEvent.type(within(form).getByLabelText('Name'), 'Y');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Upgrade your plan');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('already exists'));
  });

  it('deactivates and surfaces the "in use" delete error', async () => {
    const fetchMock = mockApi(
      base({
        'GET /products': () => page([prod()]),
        'PATCH /products/p1': () => json(200, { product: prod({ isActive: false }) }),
        'DELETE /products/p1': () =>
          json(409, {
            error: {
              code: 'PRODUCT_IN_USE',
              message: 'This product has sales history. Deactivate it instead.',
            },
          }),
      }),
    );
    renderApp('/products');
    const row = await screen.findByTestId('product-SKU-1');
    await userEvent.click(within(row).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() =>
      expect(JSON.parse(calls(fetchMock, 'PATCH /products/p1')[0]![1]!.body as string)).toEqual({
        isActive: false,
      }),
    );
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Deactivate it instead');
  });

  it('manages categories (two-level list, add, delete)', async () => {
    const fetchMock = mockApi(
      base({
        'GET /products': () => page([]),
        'POST /categories': () => json(201, {}),
        'DELETE /categories/c2': () => json(204),
      }),
    );
    renderApp('/products');
    const list = await screen.findByTestId('category-list');
    expect(await within(list).findByText('Hand tools')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Category name'), 'Garden');
    await userEvent.selectOptions(screen.getByLabelText('Parent'), 'c1');
    await userEvent.click(screen.getByRole('button', { name: 'Add category' }));
    await waitFor(() =>
      expect(JSON.parse(calls(fetchMock, 'POST /categories')[0]![1]!.body as string)).toEqual({
        name: 'Garden',
        parentId: 'c1',
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete category Hand tools' }));
    await waitFor(() => expect(calls(fetchMock, 'DELETE /categories/c2')).toHaveLength(1));
  });

  it('a Viewer can browse but sees no edit controls', async () => {
    mockApi(base({ 'GET /products': () => page([prod()]) }, makeUser({ role: 'VIEWER' })));
    renderApp('/products');
    const row = await screen.findByTestId('product-SKU-1');
    expect(screen.queryByRole('button', { name: 'New product' })).toBeNull();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Category name')).toBeNull();
  });
});

describe('product detail: BOM, suppliers, stock', () => {
  const tree = [
    {
      productId: 'p2',
      sku: 'WHEEL',
      name: 'Wheel',
      quantityPer: 2,
      totalQuantity: 2,
      bomItemId: 'b1',
      children: [
        {
          productId: 'p3',
          sku: 'SPOKE',
          name: 'Spoke',
          quantityPer: 36,
          totalQuantity: 72,
          bomItemId: 'b2',
          children: [],
        },
      ],
    },
  ];
  const setup = (extra: Record<string, () => Promise<Response> | Response> = {}) =>
    mockApi(
      base({
        'GET /products/p1': () => json(200, { product: prod({ sku: 'BIKE', name: 'Bike' }) }),
        'GET /products/p1/bom': () =>
          json(200, { product: { id: 'p1', sku: 'BIKE', name: 'Bike' }, tree }),
        'GET /products/p1/suppliers': () =>
          json(200, {
            items: [
              {
                id: 'sp1',
                supplierId: 's1',
                supplierName: 'Acme',
                productId: 'p1',
                leadTimeDays: 14,
                minOrderQty: 10,
                unitCostCents: 300,
                weeklyCapacity: null,
                isPrimary: true,
              },
            ],
          }),
        'GET /inventory': () =>
          json(200, {
            items: [
              {
                id: 'i1',
                productId: 'p1',
                productSku: 'BIKE',
                productName: 'Bike',
                locationId: 'l1',
                locationCode: 'WH-1',
                onHand: 40,
                safetyStock: 5,
                asOfDate: '2030-01-01T00:00:00Z',
              },
            ],
            total: 1,
            page: 1,
            pageSize: 100,
          }),
        'GET /products': () => page([prod(), prod({ id: 'p2', sku: 'WHEEL', name: 'Wheel' })]),
        ...extra,
      }),
    );

  it('shows the BOM as a tree with per-unit totals, suppliers and stock', async () => {
    setup();
    renderApp('/products/p1');
    const t = await screen.findByTestId('bom-tree');
    expect(within(t).getByTestId('bom-WHEEL')).toHaveTextContent('2 per parent');
    expect(within(t).getByTestId('bom-SPOKE')).toHaveTextContent(
      '36 per parent (72 total per 1 unit)',
    );
    expect(await screen.findByTestId('psupplier-Acme')).toHaveTextContent('primary');
    expect(await screen.findByText(/WH-1: 40 on hand/)).toBeInTheDocument();
  });

  it('adds a component and shows the cycle error from the server', async () => {
    const fetchMock = setup({
      'POST /bom': () =>
        json(400, {
          error: { code: 'BOM_CYCLE', message: 'Adding WHEEL to BIKE would create a cycle' },
        }),
    });
    renderApp('/products/p1');
    const form = await screen.findByRole('form', { name: 'Add component' });
    await within(form).findByRole('option', { name: /WHEEL/ });
    await userEvent.selectOptions(within(form).getByLabelText('Component'), 'p2');
    await userEvent.clear(within(form).getByLabelText('Quantity per unit'));
    await userEvent.type(within(form).getByLabelText('Quantity per unit'), '3');
    await userEvent.click(within(form).getByRole('button', { name: 'Add component' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('would create a cycle');
    expect(JSON.parse(calls(fetchMock, 'POST /bom')[0]![1]!.body as string)).toEqual({
      parentProductId: 'p1',
      componentProductId: 'p2',
      quantityPer: 3,
    });
    expect(within(form).queryByRole('option', { name: /BIKE/ })).toBeNull(); // a product can't pick itself
  });

  it('removes a component', async () => {
    const fetchMock = setup({ 'DELETE /bom/b1': () => json(204) });
    renderApp('/products/p1');
    await userEvent.click(await screen.findByRole('button', { name: 'Remove WHEEL' }));
    await waitFor(() => expect(calls(fetchMock, 'DELETE /bom/b1')).toHaveLength(1));
  });
});

describe('locations page', () => {
  it('lists, adds (types validated by select) and shows the 402 limit message', async () => {
    const fetchMock = mockApi(
      base({
        'GET /locations': () => page([loc]),
        'POST /locations': () =>
          json(402, {
            error: {
              code: 'PLAN_LIMIT_REACHED',
              message: 'Your plan allows 1 locations. Upgrade your plan to continue.',
            },
          }),
      }),
    );
    renderApp('/locations');
    expect(await screen.findByTestId('location-WH-1')).toHaveTextContent('WAREHOUSE');
    await userEvent.type(screen.getByLabelText('Code'), 'ST-1');
    await userEvent.type(screen.getByLabelText('Name'), 'Shop');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'STORE');
    await userEvent.click(screen.getByRole('button', { name: 'Add location' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Upgrade your plan');
    expect(JSON.parse(calls(fetchMock, 'POST /locations')[0]![1]!.body as string)).toEqual({
      code: 'ST-1',
      name: 'Shop',
      type: 'STORE',
    });
  });

  it('empty state and viewer read-only', async () => {
    mockApi(base({ 'GET /locations': () => page([]) }, makeUser({ role: 'VIEWER' })));
    renderApp('/locations');
    expect(await screen.findByText('No locations yet.')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New location' })).toBeNull();
  });
});

describe('suppliers page', () => {
  const supplier = { id: 's1', name: 'Acme', defaultLeadTimeDays: 21, reliabilityPct: 92 };
  it('creates a supplier, expands links, links a product with lead time and unlinks', async () => {
    const link = {
      id: 'sp1',
      supplierId: 's1',
      productId: 'p1',
      productSku: 'SKU-1',
      productName: 'Widget',
      leadTimeDays: 10,
      minOrderQty: 5,
      unitCostCents: 300,
      weeklyCapacity: 100,
      isPrimary: false,
    };
    const fetchMock = mockApi(
      base({
        'GET /suppliers': () => page([supplier]),
        'GET /suppliers/s1/products': () => json(200, { items: [link] }),
        'GET /products': () => page([prod()]),
        'POST /suppliers': () => json(201, {}),
        'POST /suppliers/s1/products': () => json(201, {}),
        'PATCH /supplier-products/sp1': () => json(200, {}),
        'DELETE /supplier-products/sp1': () => json(204),
      }),
    );
    renderApp('/suppliers');
    await userEvent.type(await screen.findByLabelText('Name'), 'Globex');
    await userEvent.click(screen.getByRole('button', { name: 'Add supplier' }));
    await waitFor(() =>
      expect(JSON.parse(calls(fetchMock, 'POST /suppliers')[0]![1]!.body as string)).toEqual({
        name: 'Globex',
        defaultLeadTimeDays: 14,
        reliabilityPct: 95,
      }),
    );

    await userEvent.click(
      within(screen.getByTestId('supplier-Acme')).getByRole('button', { name: 'Products' }),
    );
    const links = await screen.findByTestId('links-Acme');
    expect(within(links).getByTestId('link-SKU-1')).toHaveTextContent('10 d');
    const form = within(links).getByRole('form', { name: 'Link product to Acme' });
    await within(form).findByRole('option', { name: /SKU-1/ });
    await userEvent.selectOptions(within(form).getByLabelText('Product'), 'p1');
    await userEvent.clear(within(form).getByLabelText('Lead time (days)'));
    await userEvent.type(within(form).getByLabelText('Lead time (days)'), '7');
    await userEvent.click(within(form).getByRole('button', { name: 'Link product' }));
    await waitFor(() => expect(calls(fetchMock, 'POST /suppliers/s1/products')).toHaveLength(1));
    expect(
      JSON.parse(calls(fetchMock, 'POST /suppliers/s1/products')[0]![1]!.body as string),
    ).toMatchObject({ productId: 'p1', leadTimeDays: 7, minOrderQty: 1, weeklyCapacity: null });
    await userEvent.click(within(links).getByRole('button', { name: 'Make primary' }));
    await waitFor(() => expect(calls(fetchMock, 'PATCH /supplier-products/sp1')).toHaveLength(1));
    await userEvent.click(within(links).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(calls(fetchMock, 'DELETE /supplier-products/sp1')).toHaveLength(1));
  });

  it('shows server validation errors for links', async () => {
    mockApi(
      base({
        'GET /suppliers': () => page([supplier]),
        'GET /suppliers/s1/products': () => json(200, { items: [] }),
        'GET /products': () => page([prod()]),
        'POST /suppliers/s1/products': () =>
          json(409, {
            error: { code: 'LINK_EXISTS', message: 'This supplier already supplies this product' },
          }),
      }),
    );
    renderApp('/suppliers');
    await userEvent.click(
      within(await screen.findByTestId('supplier-Acme')).getByRole('button', { name: 'Products' }),
    );
    const form = await screen.findByRole('form', { name: 'Link product to Acme' });
    await within(form).findByRole('option', { name: /SKU-1/ });
    await userEvent.selectOptions(within(form).getByLabelText('Product'), 'p1');
    await userEvent.click(within(form).getByRole('button', { name: 'Link product' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already supplies');
  });
});

describe('inventory page', () => {
  const level = {
    id: 'i1',
    productId: 'p1',
    productSku: 'SKU-1',
    productName: 'Widget',
    locationId: 'l1',
    locationCode: 'WH-1',
    onHand: 120,
    safetyStock: 20,
    asOfDate: '2030-01-01T00:00:00Z',
  };
  const order = (o: Record<string, unknown>) => ({
    id: 'o1',
    productId: 'p1',
    productSku: 'SKU-1',
    locationId: 'l1',
    locationCode: 'WH-1',
    supplierId: null,
    supplierName: null,
    quantity: 50,
    expectedDate: '2030-01-10T00:00:00Z',
    isLate: false,
    ...o,
  });
  const inv = (extra: Record<string, () => Promise<Response> | Response> = {}, me = makeUser()) =>
    mockApi(
      base(
        {
          'GET /inventory': () => json(200, { items: [level], total: 1, page: 1, pageSize: 100 }),
          'GET /open-orders': () =>
            page([order({}), order({ id: 'o2', isLate: true, supplierName: 'Acme' })]),
          'GET /products': () => page([prod()]),
          'GET /locations': () => page([loc]),
          'GET /suppliers': () => page([]),
          ...extra,
        },
        me,
      ),
    );

  it('shows stock levels and saves a level', async () => {
    const fetchMock = inv({ 'PUT /inventory': () => json(200, {}) });
    renderApp('/inventory');
    expect(await screen.findByTestId('level-SKU-1-WH-1')).toHaveTextContent('120');
    const form = screen.getByRole('form', { name: 'Set stock level' });
    await within(form).findByRole('option', { name: /SKU-1/ });
    await userEvent.selectOptions(within(form).getByLabelText('Product'), 'p1');
    await userEvent.selectOptions(within(form).getByLabelText('Location'), 'l1');
    await userEvent.type(within(form).getByLabelText('On hand'), '75');
    await userEvent.click(within(form).getByRole('button', { name: 'Save level' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Stock level saved');
    expect(JSON.parse(calls(fetchMock, 'PUT /inventory')[0]![1]!.body as string)).toEqual({
      productId: 'p1',
      locationId: 'l1',
      onHand: 75,
      safetyStock: 0,
    });
  });

  it('flags late open orders', async () => {
    inv();
    renderApp('/inventory');
    await userEvent.click(await screen.findByRole('tab', { name: 'Open orders' }));
    await screen.findByTestId('order-o2');
    expect(screen.getAllByTestId('late-badge')).toHaveLength(1);
    expect(within(screen.getByTestId('order-o2')).getByTestId('late-badge')).toHaveTextContent(
      'Late',
    );
    expect(within(screen.getByTestId('order-o1')).queryByTestId('late-badge')).toBeNull();
  });

  it('a Viewer sees inventory but cannot edit; a Planner can', async () => {
    inv({}, makeUser({ role: 'VIEWER' }));
    const { unmount } = renderApp('/inventory');
    await screen.findByTestId('level-SKU-1-WH-1');
    expect(screen.queryByRole('form', { name: 'Set stock level' })).toBeNull();
    unmount();
    vi.unstubAllGlobals();
    inv({}, makeUser({ role: 'PLANNER' }));
    renderApp('/inventory');
    expect(await screen.findByRole('form', { name: 'Set stock level' })).toBeInTheDocument();
  });
});
