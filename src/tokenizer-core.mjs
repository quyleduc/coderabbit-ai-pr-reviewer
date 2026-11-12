import {get_encoding} from '@dqbd/tiktoken'

const tokenizer = get_encoding('cl100k_base')

/** @param {string} input @returns {Uint32Array} */
export function encode(input) {
  return tokenizer.encode(input)
}

/** @param {string} input @returns {number} */
export function getTokenCount(input) {
  return encode(input.replace(/<\|endoftext\|>/g, '')).length
}
