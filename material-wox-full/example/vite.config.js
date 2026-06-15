import path from "path"
import glsl from "vite-plugin-glsl"
import viteCompression from "vite-plugin-compression"
import { fileURLToPath } from "url"
import fs from "fs"
import http from "http"

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

const downloadTexturePlugin = () => ({
	name: "download-texture-plugin",
	configureServer(server) {
		server.middlewares.use("/api/download-texture", (req, res, next) => {
			const urlObj = new URL(req.url, "http://localhost")
			const imageUrl = urlObj.searchParams.get("url")
			if (!imageUrl) {
				res.statusCode = 400
				res.end(JSON.stringify({ error: "Missing url parameter" }))
				return
			}

			const destPath = path.join(dirName, "public", "generated_texture.png")
			const file = fs.createWriteStream(destPath)

			http.get(imageUrl, (response) => {
				if (response.statusCode !== 200) {
					res.statusCode = 500
					res.end(JSON.stringify({ error: `Failed to download: ${response.statusCode}` }))
					return
				}
				response.pipe(file)
				file.on("finish", () => {
					file.close()
					res.setHeader("Content-Type", "application/json")
					res.end(JSON.stringify({ success: true, path: `/generated_texture.png?t=${Date.now()}` }))
				})
			}).on("error", (err) => {
				fs.unlink(destPath, () => {})
				res.statusCode = 500
				res.end(JSON.stringify({ error: err.message }))
			})
		})
	}
})

export default {
	base: "./",
	plugins: [
		glsl.default(),
		viteCompression({ algorithm: "brotliCompress" }),
		downloadTexturePlugin()
	],
	resolve: {
		preserveSymlinks: true,
		alias: [
			{ find: "material-wox", replacement: "../src/index.js" },
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

