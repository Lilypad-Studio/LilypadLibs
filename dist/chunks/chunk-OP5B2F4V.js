"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } }// src/serializer/LilypadSerializer.ts
var LilypadSerializer = class {
  constructor(options) {
    this.options = options;
    this.fromKeys = Object.keys(options.serialization);
  }
  
  serialize(input) {
    return input.map((item) => {
      const packedItem = {};
      this.fromKeys.forEach((fromKey) => {
        const isEqual = _nullishCoalesce(this.options.serialization[fromKey].equality, () => ( ((v, d) => v === d)));
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
        const value = this.options.serialization[fromKey].deserialize(item);
        unpackedItem[fromKey] = value === void 0 ? cloneDefault(this.options.serialization[fromKey].default) : value;
      });
      return unpackedItem;
    });
  }
};
function cloneDefault(value) {
  return typeof value === "object" && value !== null ? structuredClone(value) : value;
}



exports.LilypadSerializer = LilypadSerializer;
//# sourceMappingURL=chunk-OP5B2F4V.js.map