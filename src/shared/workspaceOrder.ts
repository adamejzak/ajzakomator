/** Keep surviving cards in their saved order and append newly opened cards. */
export function workspaceOrder(saved: string[], available: string[]): string[] {
  const present = new Set(available);
  return [...new Set([...saved.filter((id) => present.has(id)), ...available])];
}

export function reorderWorkspace(order: string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !order.includes(source) || !order.includes(target)) return order;
  const next = order.filter((id) => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}
