const assert = require('node:assert');
const path = require('node:path');
const rollup = require('../../dist/rollup');
const { compareError, compareWarnings, runTestSuiteWithSamples } = require('../utils.js');

function requireWithContext(code, context, exports) {
	const module = { exports };
	const contextWithExports = { ...context, module, exports };
	const contextKeys = Object.keys(contextWithExports);
	const contextValues = contextKeys.map(key => contextWithExports[key]);
	try {
		const function_ = new Function(contextKeys, code);
		function_.apply({}, contextValues);
	} catch (error) {
		error.exports = module.exports;
		throw error;
	}
	return contextWithExports.module.exports;
}

function runCodeSplitTest(codeMap, entryId, configContext) {
	const exportsMap = Object.create(null);

	const requireFromOutputVia = importer => importee => {
		const outputId = path.posix.join(path.posix.dirname(importer), importee);
		if (outputId in exportsMap) {
			return exportsMap[outputId];
		}
		const code = codeMap[outputId];
		return typeof code !== 'undefined'
			? (exportsMap[outputId] = requireWithContext(
					code,
					{ require: requireFromOutputVia(outputId), ...context },
					(exportsMap[outputId] = {})
			  ))
			: require(importee);
	};

	const context = { assert, ...configContext };
	let exports;
	try {
		exports = requireFromOutputVia(entryId)(entryId);
	} catch (error) {
		return { error, exports: error.exports };
	}
	return { exports };
}

runTestSuiteWithSamples('function', path.join(__dirname, 'samples'), (directory, config) => {
	(config.skip ? it.skip : config.solo ? it.only : it)(
		path.basename(directory) + ': ' + config.description,
		() => {
			if (config.show) console.group(path.basename(directory));
			if (config.before) config.before();
			process.chdir(directory);
			const warnings = [];

			return rollup
				.rollup({
					input: path.join(directory, 'main.js'),
					onwarn: warning => warnings.push(warning),
					strictDeprecations: true,
					...config.options
				})
				.then(bundle => {
					let unintendedError;

					if (config.error) {
						throw new Error('Expected an error while rolling up');
					}

					let result;

					return bundle
						.generate({
							exports: 'auto',
							format: 'cjs',
							...(config.options || {}).output
						})
						.then(({ output }) => {
							if (config.generateError) {
								unintendedError = new Error('Expected an error while generating output');
							}

							result = output;
						})
						.catch(error => {
							if (config.generateError) {
								compareError(error, config.generateError);
							} else {
								throw error;
							}
						})
						.then(() => {
							if (unintendedError) throw unintendedError;
							if (config.error || config.generateError) return;

							const codeMap = result.reduce((codeMap, chunk) => {
								codeMap[chunk.fileName] = chunk.code;
								return codeMap;
							}, {});
							if (config.code) {
								config.code(result.length === 1 ? result[0].code : codeMap);
							}

							const entryId = result.length === 1 ? result[0].fileName : 'main.js';
							if (!codeMap.hasOwnProperty(entryId)) {
								throw new Error(
									`Could not find entry "${entryId}" in generated output.\nChunks:\n${Object.keys(
										codeMap
									).join('\n')}`
								);
							}
							const { exports, error } = runCodeSplitTest(codeMap, entryId, config.context);
							if (config.runtimeError) {
								if (error) {
									config.runtimeError(error);
								} else {
									unintendedError = new Error('Expected an error while executing output');
								}
							} else if (error) {
								unintendedError = error;
							}
							return Promise.resolve()
								.then(() => {
									if (config.exports && !unintendedError) {
										return config.exports(exports);
									}
								})
								.then(() => {
									if (config.bundle && !unintendedError) {
										return config.bundle(bundle);
									}
								})
								.catch(error_ => {
									if (config.runtimeError) {
										config.runtimeError(error_);
									} else {
										unintendedError = error_;
									}
								})
								.then(() => {
									if (config.show || unintendedError) {
										for (const chunk of result) {
											console.group(chunk.fileName);
											console.log(chunk.code);
											console.groupEnd();
											console.log();
										}
									}

									if (config.warnings) {
										if (Array.isArray(config.warnings)) {
											compareWarnings(warnings, config.warnings);
										} else {
											config.warnings(warnings);
										}
									} else if (warnings.length > 0) {
										throw new Error(
											`Got unexpected warnings:\n${warnings
												.map(warning => warning.message)
												.join('\n')}`
										);
									}
									if (config.show) console.groupEnd();
									if (unintendedError) throw unintendedError;
									if (config.after) config.after();
								});
						});
				})
				.catch(error => {
					if (config.error) {
						compareError(error, config.error);
					} else {
						throw error;
					}
					if (config.after) config.after();
				});
		}
	);
});
