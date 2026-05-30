/**
 * v0.4k: introspection helpers for NAPI-wrapped C++ service objects.
 *
 * QQ's wrapper.node services (msgService, buddyService, addBuddyService, …)
 * expose their methods on the prototype chain — NOT as own properties — so
 * `Object.keys(svc)` returns `[]` and treating method references as plain
 * functions (`const fn = svc.method; fn()`) throws `Illegal invocation`
 * because the C++ binding requires `this` to be the wrapper object.
 *
 * See injection fact #72.
 */

/**
 * Walk the prototype chain and collect every callable name. Skips
 * `constructor`. Property access is wrapped in try/catch since some getter
 * shapes throw when read.
 */
export function enumerateNativeServiceMethods(svc: object): string[] {
  const seen = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(svc);
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      try {
        if (typeof (svc as Record<string, unknown>)[name] === 'function') seen.add(name);
      } catch { /* property access threw — skip */ }
    }
    proto = Object.getPrototypeOf(proto);
  }
  for (const name of Object.getOwnPropertyNames(svc)) {
    if (typeof (svc as Record<string, unknown>)[name] === 'function') seen.add(name);
  }
  return [...seen].sort();
}
