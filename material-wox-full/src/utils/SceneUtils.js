export const isGroundProjectedEnv = c => {
	return c.material.fragmentShader?.includes(
		"float intersection2 = diskIntersectWithBackFaceCulling( camPos, p, h, vec3( 0.0, 1.0, 0.0 ), radius );"
	)
}

export const isChildMaterialRenderable = (c, material = c.material) => {
	const isTransparentOrTransmissive =
		material.transparent ||
		(material.transmission !== undefined && material.transmission > 0) ||
		(material.opacity !== undefined && material.opacity < 1.0)

	return (
		material.visible &&
		material.depthWrite &&
		material.depthTest &&
		!isTransparentOrTransmissive &&
		!isGroundProjectedEnv(c)
	)
}

export const didCameraMove = (camera, lastCameraPosition, lastCameraQuaternion) => {
	if (camera.position.distanceToSquared(lastCameraPosition) > 0.000001) {
		return true
	}

	if (camera.quaternion.angleTo(lastCameraQuaternion) > 0.001) {
		return true
	}

	return false
}

export const getVisibleChildren = object => {
	const queue = [object]
	const objects = []

	while (queue.length !== 0) {
		const mesh = queue.shift()
		if (mesh.material) objects.push(mesh)

		for (const c of mesh.children) {
			if (c.visible) queue.push(c)
		}
	}

	return objects
}
