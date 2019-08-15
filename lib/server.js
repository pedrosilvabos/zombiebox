/*
 * This file is part of the ZombieBox package.
 *
 * Copyright © 2012-2019, Interfaced
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
const fs = require('fs');
const fse = require('fs-extra');
const http = require('http');
const {URL} = require('url');
const chalk = require('chalk');
const espree = require('espree');
const connect = require('connect');
const send = require('send');
const httpProxy = require('http-proxy');
const morgan = require('morgan');
const serveStatic = require('serve-static');
const zbLogServer = require('zb-log-server');
const Application = require('./application');


/**
 */
class Server {
	/**
	 * @param {Application} application
	 */
	constructor(application) {
		/**
		 * @type {Application}
		 * @protected
		 */
		this._application = application;

		/**
		 * @type {Function}
		 * @protected
		 */
		this._app = connect();

		/**
		 * @type {Object}
		 * @protected
		 */
		this._proxyServer = httpProxy.createProxyServer();

		/**
		 * @type {?http.Server}
		 * @protected
		 */
		this._httpServer = null;

		/**
		 * @type {?number}
		 * @protected
		 */
		this._httpPort = null;

		this._initEndpointMiddleware();
		this._initModulesMiddleware();
		this._initStylesMiddleware();
		this._initErrorMiddleware();
	}

	/**
	 * @param {string|Function} route or middleware
	 * @param {Function=} middleware
	 * @return {connect}
	 */
	use(route, middleware) {
		return this._app.use(route, middleware);
	}

	/**
	 * @param {string} alias
	 * @param {string} dir
	 */
	serveStatic(alias, dir) {
		this.use(alias, serveStatic(dir));
	}

	/**
	 * @param {string} route
	 */
	rawProxy(route) {
		this.use(route, (req, res) => {
			// see https://github.com/nodejs/node/issues/12682
			const address = (new URL(req.url, 'request-target://')).searchParams.get('url');
			this._proxyServer.web(req, res, {
				target: address
			});
		});
	}

	/**
	 * @param {string} route
	 * @param {string} address
	 */
	proxy(route, address) {
		this.use(route, (req, res) => {
			req.headers.host = (new URL(address)).host;
			this._proxyServer.web(req, res, {
				target: address
			});
		});
	}

	/**
	 * Show all requests
	 */
	debug() {
		this.use(morgan(':remote-addr [:date] ":method :url" :status ":user-agent"'));
	}

	/**
	 * @param {string} route
	 */
	logServer(route) {
		this.use(route, zbLogServer);
	}

	/**
	 * @param {number=} port
	 * @return {Promise<string>}
	 */
	start(port = Server.DEFAULT_PORT) {
		this._httpPort = port;
		this._httpServer = http.createServer(this._app);

		return new Promise((resolve, reject) => {
			this._httpServer.listen(this._httpPort);

			this._httpServer.on('error', (e) => {
				if (e.code === 'EADDRINUSE') {
					e.message = (
						`Port ${this._httpPort} is already used by another process. ` +
						`Tip: to find this process use command like: \`lsof -i:${this._httpPort}\``
					);
				}

				reject(e);
			});

			this._httpServer.on('listening', () => {
				resolve(`Open ${chalk.cyan(this._getAddress())}`);
			});
		});
	}

	/**
	 * @param {string} fsPath
	 * @return {string}
	 */
	getModuleWebPath(fsPath) {
		return '/modules/' + this._application.fsPathToAliasedPath(fsPath);
	}

	/**
	 * @param {string} fsPath
	 * @return {string}
	 */
	getStyleWebPath(fsPath) {
		return '/styles/' + this._application.fsPathToAliasedPath(fsPath);
	}

	/**
	 * @return {string}
	 * @protected
	 */
	_getAddress() {
		return `http://localhost${this._httpPort === 80 ? '' : ':' + this._httpPort}/`;
	}

	/**
	 * @param {http.ServerResponse} res
	 * @param {Object} indexHTMLOptions
	 * @protected
	 */
	_respondIndexHTMLPage(res, indexHTMLOptions) {
		const {backdoor} = this._application.getConfig().devServer;

		if (backdoor && fse.pathExistsSync(backdoor)) {
			const entryPoint = this.getModuleWebPath(this._application.getGeneratedEntryPoint()).replace(/\.js$/, '');

			indexHTMLOptions.modules.splice(
				indexHTMLOptions.modules.indexOf(entryPoint),
				0,
				this.getModuleWebPath(backdoor)
			);
		}

		res.setHeader('Content-Type', 'text/html; charset=UTF-8');
		res.end(this._application.getIndexHTMLContent(indexHTMLOptions));
	}

	/**
	 * @protected
	 */
	_initEndpointMiddleware() {
		const entryPoint = this.getModuleWebPath(this._application.getGeneratedEntryPoint()).replace(/\.js$/, '');

		this._app.use((req, res, next) => {
			const {pathname} = new URL(req.url, 'request-target://');

			switch (pathname) {
				case '/':
				case '/index.html':
					const remoteAddress = morgan['remote-addr'](req);
					const userAgent = morgan['user-agent'](req);

					console.log(
						chalk.cyan((new Date()).toLocaleTimeString()),
						`${remoteAddress} GET ${pathname} "${userAgent}"`
					);

					this._respondIndexHTMLPage(res, {
						modules: [entryPoint],
						styles: this._application.getSortedStyles()
							.map((fsPath) => this.getStyleWebPath(fsPath))
					});
					break;

				// For backward compatibility
				case '/es5':
				case '/es5.html':
				case '/es6':
				case '/es6/':
				case '/es6.html':
				case '/bundle.html':
					res.writeHead(301, {'Location': '/'});
					res.end();
					break;

				default:
					next();
			}
		});
	}

	/**
	 * @protected
	 */
	_initModulesMiddleware() {
		this._app.use('/modules', (req, res, next) => {
			// Serve js modules
			const aliasedPath = req.url.substr('/'.length);
			let fsPath = this._application.aliasedPathToFsPath(aliasedPath);

			if (!fsPath) {
				next(new Error(`Can't resolve aliased module path ${chalk.bold(aliasedPath)}`));
				return;
			}

			if (!fsPath.endsWith('.js')) {
				fsPath += '.js';
			}

			fs.readFile(fsPath, 'utf-8', (error, content) => {
				if (error) {
					next(error);
					return;
				}

				let patchedContent = content;
				try {
					patchedContent = this._resolveAbsoluteModulePaths(content);
				} catch (e) {
					console.error(`Error while resolving module paths in ${chalk.red(fsPath)}: ${e.message}`);
				}

				res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
				res.end(patchedContent);
			});
		});
	}

	/**
	 * @param {string} content
	 * @return {string}
	 * @protected
	 */
	_resolveAbsoluteModulePaths(content) {
		const isLocal = (filename) =>
			filename.startsWith('./') ||
			filename.startsWith('../') ||
			filename.startsWith('/');

		const ast = espree.parse(content, {
			sourceType: 'module',
			ecmaVersion: 2018
		});

		let patchedContent = content;
		for (const node of ast.body.reverse()) {
			// Imports can only be at top level as per specification
			if (node.type === 'ImportDeclaration') {
				const source = node.source;
				if (source.type === 'Literal' && !isLocal(source.value)) {
					const webPath = '/modules/' + source.value;
					const replacement = source.raw.replace(source.value, webPath);
					patchedContent =
						patchedContent.slice(0, source.start) +
						replacement +
						patchedContent.slice(source.end);
				}
			}
		}

		return patchedContent;
	}

	/**
	 * @protected
	 */
	_initStylesMiddleware() {
		const stylesCache = this._application.getStylesCache();

		/**
		 * @param {string} str
		 * @return {number}
		 */
		function lengthInUtf8Bytes(str) {
			// Matches only the 10.. bytes that are non-initial characters in a multi-byte sequence.
			const m = encodeURIComponent(str).match(/%[89ABab]/g);

			return str.length + (m ? m.length : 0);
		}

		this._app.use('/styles', (req, res, next) => {
			const aliasedPath = req.url.substr('/'.length);
			const fsPath = this._application.aliasedPathToFsPath(aliasedPath);

			if (!fsPath) {
				next(new Error(`Can't resolve aliased css file path ${chalk.bold(aliasedPath)}`));
				return;
			}

			if (fsPath.endsWith('.css')) {
				try {
					res.setHeader('Content-Type', 'text/css; charset=UTF-8');

					stylesCache.getContent(fsPath)
						.then((styleContent) => {
							res.setHeader('Content-Length', lengthInUtf8Bytes(styleContent));
							res.end(styleContent);
						});
				} catch (err) {
					next(err);
				}
			} else {
				send(req, fsPath).pipe(res);
			}
		});
	}

	/**
	 * @protected
	 */
	_initErrorMiddleware() {
		this._app.use((error, req, res, next) => {
			let message = error.message;

			if (req.headers.referer) {
				const referer = req.headers.referer.split(this._getAddress()).pop();
				if (referer) {
					message += `\n\tReferrer: ${chalk.underline(referer)}`;
				}
			}
			console.error(message);
			next();
		});
	}
}


/**
 * @const {number}
 */
Server.DEFAULT_PORT = 80;


module.exports = Server;