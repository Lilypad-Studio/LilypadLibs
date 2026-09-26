//#region src/serializer/LilypadSerializer.ts
/**
* A generic serializer/deserializer for mapping objects between two shapes (`FROM` and `TO`)
* using customizable key mappings, serialization, and deserialization functions.
*
* @typeParam FROM - The source object type to serialize from.
* @typeParam TO - The target object type to serialize to.
* @typeParam KeyMap - A mapping from keys in `FROM` to keys in `TO`.
*
* @remarks
* - Each key of the source is mapped to its `target` key in the target object; the mapping must be
*   bijective, otherwise `target` is typed as `never`.
* - Custom serialization and deserialization functions can be provided for each key.
* - Default values and equality checks can be specified to skip serialization of default values.
* - When a function in the serialization map returns `undefined`, that key is omitted from the serialized output.
* - When deserialization returns `undefined`, the key gets a copy of its default value (object
*   defaults are cloned, so deserialized items never share them). `null` is kept as a value.
*
* @example
* ```typescript
* interface Source { a: number; b: string; }
* interface Target { x: number; y: string; }
* const serializer = new LilypadSerializer<Source, Target, { a: 'x'; b: 'y' }>({
*   serialization: {
*     a: { target: 'x', serialize: (item) => item.a, deserialize: (item) => item.x, default: 0 },
*     b: { target: 'y', serialize: (item) => item.b, deserialize: (item) => item.y, default: '' },
*   },
* });
* const packed = serializer.serialize([{ a: 1, b: 'foo' }]);
* const unpacked = serializer.deserialize(packed);
* ```
*/
var LilypadSerializer = class {
	constructor(options) {
		this.options = options;
		this.fromKeys = Object.keys(options.serialization);
	}
	serialize(input) {
		return input.map((item) => {
			const packedItem = {};
			this.fromKeys.forEach((fromKey) => {
				if ((this.options.serialization[fromKey].equality ?? ((v, d) => v === d))(item[fromKey], this.options.serialization[fromKey].default)) return;
				const value = this.options.serialization[fromKey].serialize(item);
				if (value === void 0) return;
				const toKey = this.options.serialization[fromKey].target;
				packedItem[toKey] = value;
			});
			return packedItem;
		});
	}
	deserialize(input) {
		return input.map((item) => {
			const unpackedItem = {};
			this.fromKeys.forEach((fromKey) => {
				const value = this.options.serialization[fromKey].deserialize(item);
				unpackedItem[fromKey] = value === void 0 ? cloneDefault(this.options.serialization[fromKey].default) : value;
			});
			return unpackedItem;
		});
	}
};
/**
* Object defaults are cloned, otherwise every deserialized item would share (and could mutate)
* the same default instance.
*/
function cloneDefault(value) {
	return typeof value === "object" && value !== null ? structuredClone(value) : value;
}
//#endregion
export { LilypadSerializer as t };

//# sourceMappingURL=serializer-DAGRw90L.mjs.map