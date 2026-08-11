
const Nothing = (() => {
	// A function declaration rather than an arrow: parts of the API are used
	// with `new` (vscode.ThemeColor, vscode.Position, ...), and an arrow
	// function is not constructible, so `new vscode.Anything()` would throw
	// "not a constructor" instead of quietly returning Nothing like every
	// other access does.
	function fn() { return Nothing }
	fn.toString = fn.toLocaleString = fn[Symbol.toPrimitive] = () => ''
	fn.valueOf = () => false

	return new Proxy(fn, {
		get: (o, key) => o.hasOwnProperty(key) ? o[key] : Nothing
	})
})()

module.exports = Nothing;
