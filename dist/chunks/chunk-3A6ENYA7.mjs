// src/serializer/LilypadSerializer.ts
var LilypadSerializer = class {
  constructor(options) {
    this.options = options;
    this.fromKeys = Object.keys(options.serialization);
  }
  fromKeys;
  serialize(input) {
    return input.map((item) => {
      const packedItem = {};
      this.fromKeys.forEach((fromKey) => {
        const isEqual = this.options.serialization[fromKey].equality ?? ((v, d) => v === d);
        if (isEqual(item[fromKey], this.options.serialization[fromKey].default)) {
          return;
        }
        const value = this.options.serialization[fromKey].serialize(item);
        if (value === void 0) {
          return;
        }
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
        unpackedItem[fromKey] = this.options.serialization[fromKey].deserialize(item) ?? cloneDefault(this.options.serialization[fromKey].default);
      });
      return unpackedItem;
    });
  }
};
function cloneDefault(value) {
  return typeof value === "object" && value !== null ? structuredClone(value) : value;
}

export {
  LilypadSerializer
};
//# sourceMappingURL=chunk-3A6ENYA7.mjs.map