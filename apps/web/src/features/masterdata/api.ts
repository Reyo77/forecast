import type {
  BomNode,
  CategoryDto,
  InventoryDto,
  LocationDto,
  OpenOrderDto,
  Paged,
  ProductDto,
  SupplierDto,
  SupplierProductDto,
} from '@supplycast/shared';
import { api } from '../../api/client';

const post = <T>(path: string, body: unknown) => api<T>(path, 'POST', body);
const patch = <T>(path: string, body: unknown) => api<T>(path, 'PATCH', body);

export const mdApi = {
  categories: () => api<{ items: CategoryDto[] }>('/categories'),
  createCategory: (b: { name: string; parentId?: string | null }) => post('/categories', b),
  deleteCategory: (id: string) => api(`/categories/${id}`, 'DELETE'),
  products: (qs: string) => api<Paged<ProductDto>>(`/products?${qs}`),
  product: (id: string) => api<{ product: ProductDto }>(`/products/${id}`),
  createProduct: (b: unknown) => post<{ product: ProductDto }>('/products', b),
  updateProduct: (id: string, b: unknown) => patch<{ product: ProductDto }>(`/products/${id}`, b),
  deleteProduct: (id: string) => api(`/products/${id}`, 'DELETE'),
  locations: () => api<Paged<LocationDto>>('/locations?pageSize=100'),
  createLocation: (b: unknown) => post('/locations', b),
  updateLocation: (id: string, b: unknown) => patch(`/locations/${id}`, b),
  deleteLocation: (id: string) => api(`/locations/${id}`, 'DELETE'),
  suppliers: () => api<Paged<SupplierDto>>('/suppliers?pageSize=100'),
  createSupplier: (b: unknown) => post('/suppliers', b),
  updateSupplier: (id: string, b: unknown) => patch(`/suppliers/${id}`, b),
  deleteSupplier: (id: string) => api(`/suppliers/${id}`, 'DELETE'),
  supplierProducts: (supplierId: string) =>
    api<{ items: SupplierProductDto[] }>(`/suppliers/${supplierId}/products`),
  productSuppliers: (productId: string) =>
    api<{ items: SupplierProductDto[] }>(`/products/${productId}/suppliers`),
  linkProduct: (supplierId: string, b: unknown) => post(`/suppliers/${supplierId}/products`, b),
  updateLink: (id: string, b: unknown) => patch(`/supplier-products/${id}`, b),
  deleteLink: (id: string) => api(`/supplier-products/${id}`, 'DELETE'),
  bom: (productId: string) =>
    api<{ product: { id: string; sku: string; name: string }; tree: BomNode[] }>(
      `/products/${productId}/bom`,
    ),
  addBom: (b: unknown) => post('/bom', b),
  deleteBom: (id: string) => api(`/bom/${id}`, 'DELETE'),
  inventory: (qs = '') => api<Paged<InventoryDto>>(`/inventory?pageSize=100${qs}`),
  saveInventory: (b: unknown) => api('/inventory', 'PUT', b),
  deleteInventory: (id: string) => api(`/inventory/${id}`, 'DELETE'),
  openOrders: () => api<Paged<OpenOrderDto>>('/open-orders?pageSize=100'),
  createOrder: (b: unknown) => post('/open-orders', b),
  deleteOrder: (id: string) => api(`/open-orders/${id}`, 'DELETE'),
};

export const allProducts = () => mdApi.products('pageSize=100');
