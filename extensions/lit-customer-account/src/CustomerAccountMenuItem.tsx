import { reactExtension, MenuItem } from "@shopify/ui-extensions-react/customer-account";

/**
 * Menu item under "Orders" (customer-account.order-index.menu-item.render)
 * that links into our full-page extension. Without this, the page exists
 * but customers can't find it from the customer accounts navigation.
 */
export default reactExtension(
  "customer-account.order-index.menu-item.render",
  () => <MenuItem to="extension:/">LIT Hub</MenuItem>,
);
