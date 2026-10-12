import { expect, test } from '@playwright/test';

test('Phase 3: category → products → location → supplier with lead time → BOM (cycle blocked) → inventory + late order', async ({
  page,
}) => {
  const stamp = Date.now();
  await page.goto('/signup');
  await page.getByLabel('Company name').fill(`Phase3 Co ${stamp}`);
  await page.getByLabel('Your name').fill('Mia Owner');
  await page.getByLabel('Email').fill(`p3-${stamp}@example.com`);
  await page.getByLabel('Password').fill('Password123');
  await page.getByRole('button', { name: 'Sign up' }).click();

  // Category + products
  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByLabel('Category name').fill('Bikes');
  await page.getByRole('button', { name: 'Add category' }).click();
  await expect(page.getByTestId('category-list')).toContainText('Bikes');

  for (const [sku, name, component] of [
    ['BIKE', 'City Bike', false],
    ['WHEEL', 'Wheel', true],
  ] as const) {
    await page.getByRole('button', { name: 'New product' }).click();
    const form = page.getByRole('form', { name: 'New product' });
    await form.getByLabel('SKU').fill(sku);
    await form.getByLabel('Name').fill(name);
    await form.getByLabel('Category').selectOption({ label: 'Bikes' });
    await form.getByLabel('Unit cost ($)').fill('10');
    await form.getByLabel('Unit price ($)').fill('25.50');
    if (component) await form.getByLabel('Component').check();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId(`product-${sku}`)).toBeVisible();
  }
  await expect(page.getByTestId('product-BIKE')).toContainText('$25.50');

  // Duplicate SKU is rejected
  await page.getByRole('button', { name: 'New product' }).click();
  const dup = page.getByRole('form', { name: 'New product' });
  await dup.getByLabel('SKU').fill('BIKE');
  await dup.getByLabel('Name').fill('Again');
  await dup.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('already exists');
  await dup.getByRole('button', { name: 'Cancel' }).click();

  // Search filter
  await page.getByLabel('Search').fill('whe');
  await expect(page.getByTestId('product-WHEEL')).toBeVisible();
  await expect(page.getByTestId('product-BIKE')).toHaveCount(0);
  await page.getByLabel('Search').fill('');

  // Location
  await page.getByRole('link', { name: 'Locations' }).click();
  await page.getByLabel('Code').fill('WH-1');
  await page.getByLabel('Name').fill('Main warehouse');
  await page.getByRole('button', { name: 'Add location' }).click();
  await expect(page.getByTestId('location-WH-1')).toBeVisible();

  // Supplier with lead time, linked to WHEEL
  await page.getByRole('link', { name: 'Suppliers' }).click();
  await page.getByLabel('Name').fill('Acme Supplies');
  await page.getByLabel('Default lead time (days)').fill('21');
  await page.getByRole('button', { name: 'Add supplier' }).click();
  await page
    .getByTestId('supplier-Acme Supplies')
    .getByRole('button', { name: 'Products' })
    .click();
  const link = page.getByRole('form', { name: 'Link product to Acme Supplies' });
  await link.getByLabel('Product').selectOption({ label: 'WHEEL — Wheel' });
  await link.getByLabel('Lead time (days)').fill('10');
  await link.getByLabel('MOQ').fill('25');
  await link.getByRole('button', { name: 'Link product' }).click();
  await expect(page.getByTestId('link-WHEEL')).toContainText('10 d');
  await expect(page.getByTestId('link-WHEEL')).toContainText('primary');
  // Lead time outside 1–365 is rejected
  await link.getByLabel('Product').selectOption({ label: 'BIKE — City Bike' });
  await link.getByLabel('Lead time (days)').fill('400');
  await link.getByRole('button', { name: 'Link product' }).click();
  expect(
    await link
      .getByLabel('Lead time (days)')
      .evaluate((el) => (el as HTMLInputElement).validity.rangeOverflow),
  ).toBe(true);
  await expect(page.getByTestId('link-BIKE')).toHaveCount(0);

  // BOM: BIKE uses 2 WHEEL; the reverse is a cycle
  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByTestId('product-BIKE').getByRole('link', { name: 'BIKE' }).click();
  const add = page.getByRole('form', { name: 'Add component' });
  await add.getByLabel('Component').selectOption({ label: 'WHEEL — Wheel' });
  await add.getByLabel('Quantity per unit').fill('2');
  await add.getByRole('button', { name: 'Add component' }).click();
  await expect(page.getByTestId('bom-WHEEL')).toContainText('2 per parent');
  await page.getByRole('link', { name: '← Products' }).click();
  await page.getByTestId('product-WHEEL').getByRole('link', { name: 'WHEEL' }).click();
  const rev = page.getByRole('form', { name: 'Add component' });
  await rev.getByLabel('Component').selectOption({ label: 'BIKE — City Bike' });
  await rev.getByRole('button', { name: 'Add component' }).click();
  await expect(page.getByRole('alert')).toContainText('cycle');
  await expect(page.getByTestId('psupplier-Acme Supplies')).toContainText('10 days');

  // Inventory level + a late open order
  await page.getByRole('link', { name: 'Inventory' }).click();
  const level = page.getByRole('form', { name: 'Set stock level' });
  await level.getByLabel('Product').selectOption({ label: 'WHEEL — Wheel' });
  await level.getByLabel('Location').selectOption({ label: 'WH-1' });
  await level.getByLabel('On hand').fill('-5');
  await level.getByRole('button', { name: 'Save level' }).click();
  await expect(page.getByTestId('level-WHEEL-WH-1')).toHaveCount(0); // negative stock is not accepted
  await level.getByLabel('On hand').fill('120');
  await level.getByLabel('Safety stock').fill('20');
  await level.getByRole('button', { name: 'Save level' }).click();
  await expect(page.getByTestId('level-WHEEL-WH-1')).toContainText('120');

  await page.getByRole('tab', { name: 'Open orders' }).click();
  const order = page.getByRole('form', { name: 'Add open order' });
  await order.getByLabel('Product').selectOption({ label: 'WHEEL — Wheel' });
  await order.getByLabel('Location').selectOption({ label: 'WH-1' });
  await order.getByLabel('Supplier').selectOption({ label: 'Acme Supplies' });
  await order.getByLabel('Quantity').fill('300');
  await order.getByLabel('Expected date').fill('2020-01-15');
  await order.getByRole('button', { name: 'Add order' }).click();
  await expect(page.getByTestId('late-badge')).toBeVisible();
});
