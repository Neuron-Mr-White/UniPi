export function shouldShowSidekickWidget(busy: boolean, attached: boolean): boolean {
  return busy && !attached;
}
