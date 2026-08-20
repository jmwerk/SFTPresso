
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
		get: (o, key) => {
			// Unlike everything else here, callers actually await what this
			// returns and run code inside the callback -- Nothing() would give
			// back Nothing, which is a thenable that never settles and hangs
			// any test that awaits it.
			if (key === 'withProgress') {
				return (_options, task) =>
					Promise.resolve(
						task(
							{ report() {} },
							{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
						)
					)
			}
			return o.hasOwnProperty(key) ? o[key] : Nothing
		}
	})
})()

module.exports = Nothing;
