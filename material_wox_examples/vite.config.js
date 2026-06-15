import fs from "fs"
import path from "path"
import glsl from "vite-plugin-glsl"
import viteCompression from "vite-plugin-compression"
import { fileURLToPath } from "url"

const patchPath = (p) => {
	if (typeof p === "string") {
		if (p.startsWith("\\\\ade\\Utenti")) {
			return p.replace("\\\\ade\\Utenti", "R:")
		}
		if (p.startsWith("//ade/Utenti")) {
			return p.replace("//ade/Utenti", "R:")
		}
		if (p.startsWith("R:\\ade\\Utenti")) {
			return p.replace("R:\\ade\\Utenti", "R:")
		}
		if (p.startsWith("R:/ade/Utenti")) {
			return p.replace("R:/ade/Utenti", "R:")
		}
	}
	return p
}

const originalRealpathSync = fs.realpathSync
fs.realpathSync = function (path, options) {
	return patchPath(originalRealpathSync(path, options))
}
if (originalRealpathSync.native) {
	const originalNative = originalRealpathSync.native
	fs.realpathSync.native = function (path, options) {
		return patchPath(originalNative(path, options))
	}
}

const originalRealpath = fs.realpath
fs.realpath = function (path, options, callback) {
	if (typeof options === "function") {
		callback = options
		options = undefined
	}
	originalRealpath(path, options, (err, resolvedPath) => {
		if (err) return callback(err)
		callback(null, patchPath(resolvedPath))
	})
}

if (fs.promises && fs.promises.realpath) {
	const originalPromisesRealpath = fs.promises.realpath
	fs.promises.realpath = async function (path, options) {
		const resolved = await originalPromisesRealpath(path, options)
		return patchPath(resolved)
	}
}

const dirName = process.cwd()

export default {
	plugins: [glsl.default(), viteCompression({ algorithm: "brotliCompress" })],
	resolve: {
		alias: [
			{ find: "material-wox", replacement: dirName + "/../material-wox-full/src/index.js" },
			{ find: "../src", replacement: dirName + "/../material-wox-full/src" },
			{ find: "three", replacement: dirName + "/node_modules/three" },
			{ find: "postprocessing", replacement: dirName + "/node_modules/postprocessing" }
		]
	},
	server: {
		fs: {
			allow: [".."]
		}
	}
}
