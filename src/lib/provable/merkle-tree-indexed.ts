import { Poseidon as PoseidonBigint } from '../../bindings/crypto/poseidon.js';
import { Bool, Field } from './wrapped.js';
import { Option } from './option.js';
import { Struct } from './types/struct.js';
import { From, InferValue } from '../../bindings/lib/provable-generic.js';
import { assert } from './gadgets/common.js';
import { Unconstrained } from './types/unconstrained.js';
import { Provable } from './provable.js';
import { Poseidon } from './crypto/poseidon.js';
import { conditionalSwap } from './merkle-tree.js';
import { provableFromClass } from './types/provable-derivers.js';

// external API
export { IndexedMerkleMap };

// internal API
export { Leaf };

/**
 * Class factory for an Indexed Merkle Map with a given height.
 *
 * ```ts
 * class MerkleMap extends IndexedMerkleMap(33) {}
 *
 * let map = new MerkleMap();
 *
 * map.insert(2n, 14n);
 * map.insert(1n, 13n);
 *
 * let x = map.get(2n); // 14
 * ```
 *
 * Indexed Merkle maps can be used directly in provable code:
 *
 * ```ts
 * ZkProgram({
 *   methods: {
 *     test: {
 *       privateInputs: [MerkleMap.provable, Field],
 *
 *       method(map: MerkleMap, key: Field) {
 *         // get the value associated with `key`
 *         let value = map.getOption(key).orElse(0n);
 *
 *         // increment the value by 1
 *         map.set(key, value.add(1));
 *       }
 *     }
 *   }
 * })
 * ```
 */
function IndexedMerkleMap(height: number): typeof IndexedMerkleMapBase {
  assert(height > 0, 'height must be positive');
  assert(
    height < 53,
    'height must be less than 53, so that we can use 64-bit floats to represent indices.'
  );

  return class IndexedMerkleMap extends IndexedMerkleMapBase {
    constructor() {
      // we can't access the abstract `height` property in the base constructor
      super();
    }

    get height() {
      return height;
    }

    static provable = provableFromClass(IndexedMerkleMap, provableBase);
  };
}

const provableBase = {
  root: Field,
  length: Field,
  data: Unconstrained.provableWithEmpty({
    nodes: [] as (bigint | undefined)[][],
    sortedLeaves: [] as LeafValue[],
  }),
};

class IndexedMerkleMapBase {
  // data defining the provable interface of a tree
  root: Field;
  length: Field; // length of the leaves array

  // static data defining constraints
  get height() {
    return 0;
  }

  // the raw data stored in the tree, plus helper structures
  readonly data: Unconstrained<{
    // for every level, an array of hashes
    readonly nodes: (bigint | undefined)[][];

    // leaves sorted by key, with a linked list encoded by nextKey
    // we always have
    // sortedLeaves[0].key = 0
    // sortedLeaves[n-1].nextKey = Field.ORDER - 1
    // for i=0,...n-2, sortedLeaves[i].nextKey = sortedLeaves[i+1].key
    readonly sortedLeaves: LeafValue[];
  }>;

  // we'd like to do `abstract static provable` here but that's not supported
  static provable: Provable<
    IndexedMerkleMapBase,
    InferValue<typeof provableBase>
  > = undefined as any;

  /**
   * Creates a new, empty Indexed Merkle Map, given its height.
   */
  constructor() {
    let height = this.height;

    let nodes: (bigint | undefined)[][] = Array(height);
    for (let level = 0; level < height; level++) {
      nodes[level] = [];
    }

    let firstLeaf = IndexedMerkleMapBase._firstLeaf;
    let firstNode = Leaf.hashNode(firstLeaf).toBigInt();
    let root = Nodes.setLeaf(nodes, 0, firstNode);
    this.root = Field(root);
    this.length = Field(1);

    this.data = Unconstrained.from({ nodes, sortedLeaves: [firstLeaf] });
  }

  static _firstLeaf = {
    key: 0n,
    value: 0n,
    // maximum, which is always greater than any key that is a hash
    nextKey: Field.ORDER - 1n,
    index: 0,
  };

  /**
   * Insert a new leaf `(key, value)`.
   *
   * Proves that `key` doesn't exist yet.
   */
  insert(key: Field | bigint, value: Field | bigint) {
    key = Field(key);
    value = Field(value);

    // check that we can insert a new leaf, by asserting the length fits in the tree
    let index = this.length;
    let indexBits = index.toBits(this.height - 1);

    // prove that the key doesn't exist yet by presenting a valid low node
    let low = Provable.witness(Leaf, () => this._findLeaf(key).low);
    let lowPath = this._proveInclusion(low, 'Invalid low node (root)');
    low.key.assertLessThan(key, 'Invalid low node (key)');

    // if the key does exist, we have lowNode.nextKey == key, and this line fails
    key.assertLessThan(low.nextKey, 'Key already exists in the tree');

    // at this point, we know that we have a valid insertion; so we can mutate internal data

    // update low node
    let newLow = { ...low, nextKey: key };
    this.root = this._proveUpdate(newLow, lowPath);
    this._setLeafUnconstrained(true, newLow);

    // create new leaf to append
    let leaf = Leaf.nextAfter(newLow, index, {
      key,
      value,
      nextKey: low.nextKey,
    });

    // prove empty slot in the tree, and insert our leaf
    let path = this._proveEmpty(indexBits);
    this.root = this._proveUpdate(leaf, path);
    this.length = this.length.add(1);
    this._setLeafUnconstrained(false, leaf);
  }

  /**
   * Update an existing leaf `(key, value)`.
   *
   * Proves that the `key` exists.
   */
  update(key: Field | bigint, value: Field | bigint) {
    key = Field(key);
    value = Field(value);

    // prove that the key exists by presenting a leaf that contains it
    let self = Provable.witness(Leaf, () => this._findLeaf(key).self);
    let path = this._proveInclusion(self, 'Key does not exist in the tree');
    self.key.assertEquals(key, 'Invalid leaf (key)');

    // at this point, we know that we have a valid update; so we can mutate internal data

    // update leaf
    let newSelf = { ...self, value };
    this.root = this._proveUpdate(newSelf, path);
    this._setLeafUnconstrained(true, newSelf);
  }

  /**
   * Perform _either_ an insertion or update, depending on whether the key exists.
   *
   * Note: This method is handling both the `insert()` and `update()` case at the same time, so you
   * can use it if you don't know whether the key exists or not.
   *
   * However, this comes at an efficiency cost, so prefer to use `insert()` or `update()` if you know whether the key exists.
   */
  set(key: Field | bigint, value: Field | bigint) {
    key = Field(key);
    value = Field(value);

    // prove whether the key exists or not, by showing a valid low node
    let { low, self } = Provable.witness(LeafPair, () => this._findLeaf(key));
    let lowPath = this._proveInclusion(low, 'Invalid low node (root)');
    low.key.assertLessThan(key, 'Invalid low node (key)');
    key.assertLessThanOrEqual(low.nextKey, 'Invalid low node (next key)');

    // the key exists iff lowNode.nextKey == key
    let keyExists = low.nextKey.equals(key);

    // the leaf's index depends on whether it exists
    let index = Provable.witness(Field, () => self.index.get());
    index = Provable.if(keyExists, index, this.length);
    let indexBits = index.toBits(this.height - 1);

    // at this point, we know that we have a valid update or insertion; so we can mutate internal data

    // update low node, or leave it as is
    let newLow = { ...low, nextKey: key };
    this.root = this._proveUpdate(newLow, lowPath);
    this._setLeafUnconstrained(true, newLow);

    // prove inclusion of this leaf if it exists
    let path = this._proveInclusionOrEmpty(
      keyExists,
      indexBits,
      self,
      'Invalid leaf (root)'
    );
    assert(keyExists.implies(self.key.equals(key)), 'Invalid leaf (key)');

    // update leaf, or append a new one
    let newLeaf = Leaf.nextAfter(newLow, index, {
      key,
      value,
      nextKey: Provable.if(keyExists, self.nextKey, low.nextKey),
    });
    this.root = this._proveUpdate(newLeaf, path);
    this.length = Provable.if(keyExists, this.length, this.length.add(1));
    this._setLeafUnconstrained(keyExists, newLeaf);
  }

  /**
   * Get a value from a key.
   *
   * Proves that the key already exists in the map yet and fails otherwise.
   */
  get(key: Field | bigint): Field {
    key = Field(key);

    // prove that the key exists by presenting a leaf that contains it
    let self = Provable.witness(Leaf, () => this._findLeaf(key).self);
    this._proveInclusion(self, 'Key does not exist in the tree');
    self.key.assertEquals(key, 'Invalid leaf (key)');

    return self.value;
  }

  /**
   * Get a value from a key.
   *
   * Returns an option which is `None` if the key doesn't exist. (In that case, the option's value is unconstrained.)
   *
   * Note that this is more flexible than `get()` and allows you to handle the case where the key doesn't exist.
   * However, it uses about twice as many constraints for that reason.
   */
  getOption(key: Field | bigint): Option<Field, bigint> {
    key = Field(key);

    // prove whether the key exists or not, by showing a valid low node
    let { low, self } = Provable.witness(LeafPair, () => this._findLeaf(key));
    this._proveInclusion(low, 'Invalid low node (root)');
    low.key.assertLessThan(key, 'Invalid low node (key)');
    key.assertLessThanOrEqual(low.nextKey, 'Invalid low node (next key)');

    // the key exists iff lowNode.nextKey == key
    let keyExists = low.nextKey.equals(key);

    // prove inclusion of this leaf if it exists
    this._proveInclusionIf(keyExists, self, 'Invalid leaf (root)');
    assert(keyExists.implies(self.key.equals(key)), 'Invalid leaf (key)');

    return new OptionField({ isSome: keyExists, value: self.value });
  }

  // methods to check for inclusion for a key without being concerned about the value

  /**
   * Prove that the given key exists in the map.
   */
  assertIncluded(key: Field | bigint, message?: string) {
    key = Field(key);

    // prove that the key exists by presenting a leaf that contains it
    let self = Provable.witness(Leaf, () => this._findLeaf(key).self);
    this._proveInclusion(self, message ?? 'Key does not exist in the tree');
    self.key.assertEquals(key, 'Invalid leaf (key)');
  }

  /**
   * Prove that the given key does not exist in the map.
   */
  assertNotIncluded(key: Field | bigint, message?: string) {
    key = Field(key);

    // prove that the key does not exist yet, by showing a valid low node
    let low = Provable.witness(Leaf, () => this._findLeaf(key).low);
    this._proveInclusion(low, 'Invalid low node (root)');
    low.key.assertLessThan(key, 'Invalid low node (key)');
    key.assertLessThan(
      low.nextKey,
      message ?? 'Key already exists in the tree'
    );
  }

  /**
   * Check whether the given key exists in the map.
   */
  isIncluded(key: Field | bigint): Bool {
    key = Field(key);

    // prove that the key does not exist yet, by showing a valid low node
    let low = Provable.witness(Leaf, () => this._findLeaf(key).low);
    this._proveInclusion(low, 'Invalid low node (root)');
    low.key.assertLessThan(key, 'Invalid low node (key)');
    key.assertLessThanOrEqual(low.nextKey, 'Invalid low node (next key)');

    return low.nextKey.equals(key);
  }

  // helper methods

  /**
   * Helper method to prove inclusion of a leaf in the tree.
   */
  _proveInclusion(leaf: Leaf, message?: string) {
    let node = Leaf.hashNode(leaf);
    // here, we don't care at which index the leaf is included, so we pass it in as unconstrained
    let { root, path } = this._computeRoot(node, leaf.index);
    root.assertEquals(this.root, message ?? 'Leaf is not included in the tree');

    return path;
  }

  /**
   * Helper method to conditionally prove inclusion of a leaf in the tree.
   */
  _proveInclusionIf(condition: Bool, leaf: Leaf, message?: string) {
    let node = Leaf.hashNode(leaf);
    // here, we don't care at which index the leaf is included, so we pass it in as unconstrained
    let { root } = this._computeRoot(node, leaf.index);
    assert(
      condition.implies(root.equals(this.root)),
      message ?? 'Leaf is not included in the tree'
    );
  }

  /**
   * Helper method to prove inclusion of an empty leaf in the tree.
   *
   * This validates the path against the current root, so that we can use it to insert a new leaf.
   */
  _proveEmpty(index: Bool[]) {
    let node = Field(0n);
    let { root, path } = this._computeRoot(node, index);
    root.assertEquals(this.root, 'Leaf is not empty');

    return path;
  }

  /**
   * Helper method to conditionally prove inclusion of a leaf in the tree.
   *
   * If the condition is false, we prove that the tree contains an empty leaf instead.
   */
  _proveInclusionOrEmpty(
    condition: Bool,
    index: Bool[],
    leaf: BaseLeaf,
    message?: string
  ) {
    let node = Provable.if(condition, Leaf.hashNode(leaf), Field(0n));
    let { root, path } = this._computeRoot(node, index);
    root.assertEquals(this.root, message ?? 'Leaf is not included in the tree');

    return path;
  }

  /**
   * Helper method to update the root against a previously validated path.
   *
   * Returns the new root.
   */
  _proveUpdate(leaf: BaseLeaf, path: { index: Bool[]; witness: Field[] }) {
    let node = Leaf.hashNode(leaf);
    let { root } = this._computeRoot(node, path.index, path.witness);
    return root;
  }

  /**
   * Helper method to compute the root given a leaf node and its index.
   *
   * The index can be given as a `Field` or as an array of bits.
   */
  _computeRoot(
    node: Field,
    index: Unconstrained<number> | Bool[],
    witness?: Field[]
  ) {
    // if the index was passed in as unconstrained, we witness its bits here
    let indexBits =
      index instanceof Unconstrained
        ? Provable.witness(Provable.Array(Bool, this.height - 1), () =>
            Field(index.get()).toBits(this.height - 1)
          )
        : index;

    // if the witness was not passed in, we create it here
    let witness_ =
      witness ??
      Provable.witnessFields(this.height - 1, () => {
        let witness: bigint[] = [];
        let index = Number(Field.fromBits(indexBits));
        let { nodes } = this.data.get();

        for (let level = 0; level < this.height - 1; level++) {
          let i = index % 2 === 0 ? index + 1 : index - 1;
          let sibling = Nodes.getNode(nodes, level, i, false);
          witness.push(sibling);
          index >>= 1;
        }

        return witness;
      });

    assert(indexBits.length === this.height - 1, 'Invalid index size');
    assert(witness_.length === this.height - 1, 'Invalid witness size');

    for (let level = 0; level < this.height - 1; level++) {
      let isRight = indexBits[level];
      let sibling = witness_[level];

      let [right, left] = conditionalSwap(isRight, node, sibling);
      node = Poseidon.hash([left, right]);
    }
    // now, `node` is the root of the tree
    return { root: node, path: { witness: witness_, index: indexBits } };
  }

  /**
   * Given a key, returns both the low node and the leaf that contains the key.
   *
   * If the key does not exist, a dummy value is returned for the leaf.
   *
   * Can only be called outside provable code.
   */
  _findLeaf(key_: Field | bigint): InferValue<typeof LeafPair> {
    let key = typeof key_ === 'bigint' ? key_ : key_.toBigInt();
    assert(key >= 0n, 'key must be positive');
    let leaves = this.data.get().sortedLeaves;

    // this case is typically invalid, but we want to handle it gracefully here
    // and reject it using comparison constraints
    if (key === 0n)
      return {
        low: Leaf.toValue(Leaf.empty()),
        self: Leaf.fromBigints(leaves[0], 0),
      };

    let { lowIndex, foundValue } = bisectUnique(
      key,
      (i) => leaves[i].key,
      leaves.length
    );
    let iLow = foundValue ? lowIndex - 1 : lowIndex;
    let low = Leaf.fromBigints(leaves[iLow], iLow);

    let iSelf = foundValue ? lowIndex : 0;
    let selfBase = foundValue ? leaves[lowIndex] : Leaf.toBigints(Leaf.empty());
    let self = Leaf.fromBigints(selfBase, iSelf);
    return { low, self };
  }

  /**
   * Update or append a leaf in our internal data structures
   */
  _setLeafUnconstrained(leafExists: Bool | boolean, leaf: Leaf) {
    Provable.asProver(() => {
      let { nodes, sortedLeaves } = this.data.get();

      // update internal hash nodes
      let i = leaf.index.get();
      Nodes.setLeaf(nodes, i, Leaf.hashNode(leaf).toBigInt());

      // update sorted list
      let leafValue = Leaf.toBigints(leaf);
      let iSorted = leaf.sortedIndex.get();

      if (Bool(leafExists).toBoolean()) {
        sortedLeaves[iSorted] = leafValue;
      } else {
        sortedLeaves.splice(iSorted, 0, leafValue);
      }
    });
  }
}

// helpers for updating nodes

type Nodes = (bigint | undefined)[][];
namespace Nodes {
  /**
   * Sets the leaf node at the given index, updates all parent nodes and returns the new root.
   */
  export function setLeaf(nodes: Nodes, index: number, leaf: bigint) {
    nodes[0][index] = leaf;
    let height = nodes.length;

    for (let level = 0; level < height - 1; level++) {
      let isLeft = index % 2 === 0;
      index = Math.floor(index / 2);

      let left = getNode(nodes, level, index * 2, isLeft);
      let right = getNode(nodes, level, index * 2 + 1, !isLeft);
      nodes[level + 1][index] = PoseidonBigint.hash([left, right]);
    }
    return getNode(nodes, height - 1, 0, true);
  }

  export function getNode(
    nodes: Nodes,
    level: number,
    index: number,
    // whether the node is required to be non-empty
    nonEmpty: boolean
  ) {
    let node = nodes[level]?.[index];
    if (node === undefined) {
      if (nonEmpty)
        throw Error(
          `node at level=${level}, index=${index} was expected to be known, but isn't.`
        );
      node = empty(level);
    }
    return node;
  }

  // cache of empty nodes (=: zero leaves and nodes with only empty nodes below them)
  const emptyNodes = [0n];

  export function empty(level: number) {
    for (let i = emptyNodes.length; i <= level; i++) {
      let zero = emptyNodes[i - 1];
      emptyNodes[i] = PoseidonBigint.hash([zero, zero]);
    }
    return emptyNodes[level];
  }
}

// leaf

class BaseLeaf extends Struct({
  key: Field,
  value: Field,
  nextKey: Field,
}) {}

class Leaf extends Struct({
  value: Field,
  key: Field,
  nextKey: Field,

  index: Unconstrained.provableWithEmpty(0),
  sortedIndex: Unconstrained.provableWithEmpty(0),
}) {
  /**
   * Compute a leaf node: the hash of a leaf that becomes part of the Merkle tree.
   */
  static hashNode(leaf: From<typeof BaseLeaf>) {
    // note: we don't have to include the `index` in the leaf hash,
    // because computing the root already commits to the index
    return Poseidon.hashPacked(BaseLeaf, BaseLeaf.fromValue(leaf));
  }

  /**
   * Create a new leaf, given its low node and index.
   */
  static nextAfter(low: Leaf, index: Field, leaf: BaseLeaf): Leaf {
    return {
      key: leaf.key,
      value: leaf.value,
      nextKey: leaf.nextKey,
      index: Unconstrained.witness(() => Number(index)),
      sortedIndex: Unconstrained.witness(() => low.sortedIndex.get() + 1),
    };
  }

  static toBigints(leaf: Leaf): LeafValue {
    return {
      key: leaf.key.toBigInt(),
      value: leaf.value.toBigInt(),
      nextKey: leaf.nextKey.toBigInt(),
      index: leaf.index.get(),
    };
  }

  static fromBigints(leaf: LeafValue, sortedIndex: number) {
    return {
      ...leaf,
      index: Unconstrained.from(leaf.index),
      sortedIndex: Unconstrained.from(sortedIndex),
    };
  }
}

type LeafValue = {
  value: bigint;
  key: bigint;
  nextKey: bigint;
  index: number;
};

class LeafPair extends Struct({ low: Leaf, self: Leaf }) {}

class OptionField extends Option(Field) {}

// helper

/**
 * Bisect indices in an array of unique values that is sorted in ascending order.
 *
 * `getValue()` returns the value at the given index.
 *
 * We return
 * - `lowIndex := max { i in [0, length) | getValue(i) <= target }`
 * - `foundValue` := whether `getValue(lowIndex) == target`
 */
function bisectUnique(
  target: bigint,
  getValue: (index: number) => bigint,
  length: number
): {
  lowIndex: number;
  foundValue: boolean;
} {
  let [iLow, iHigh] = [0, length - 1];
  // handle out of bounds
  if (getValue(iLow) > target) return { lowIndex: -1, foundValue: false };
  if (getValue(iHigh) < target) return { lowIndex: iHigh, foundValue: false };

  // invariant: 0 <= iLow <= lowIndex <= iHigh < length
  // since we are decreasing (iHigh - iLow) in every iteration, we'll terminate
  while (iHigh !== iLow) {
    // we have iLow < iMid <= iHigh
    // in both branches, the range gets strictly smaller
    let iMid = Math.ceil((iLow + iHigh) / 2);
    if (getValue(iMid) <= target) {
      // iMid is in the candidate set, and strictly larger than iLow
      // preserves iLow <= lowIndex
      iLow = iMid;
    } else {
      // iMid is no longer in the candidate set, so we can exclude it right away
      // preserves lowIndex <= iHigh
      iHigh = iMid - 1;
    }
  }

  return { lowIndex: iLow, foundValue: getValue(iLow) === target };
}
