import { customerGreetingName, type Customer } from "./customer";
import { posterName, type User } from "./lead";

// What a creative can use from a customer, for the detail page ("What the creative can use from
// this customer"). Pure. The phone number is deliberately not on this list: no creative uses it.

export type CustomerDataItem = { key: "customer_name" | "company_name" | "product" | "salesperson"; label: string; value: string | null; ready: boolean };

export function customerDataItems(customer: Customer, user: User): CustomerDataItem[] {
  const products = customer.products;
  const productValue = products.length === 0 ? null : products.length === 1 ? products[0].name : `${products.length} products. You choose one when you personalize`;
  return [
    { key: "customer_name", label: "Customer name", value: customerGreetingName(customer), ready: true },
    { key: "company_name", label: "Company", value: customer.company, ready: true },
    { key: "product", label: "Product", value: productValue, ready: products.length > 0 },
    { key: "salesperson", label: "Your name as contact", value: posterName(user), ready: true },
  ];
}
