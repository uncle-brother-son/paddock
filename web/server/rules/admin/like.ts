// W58 (W45 audit row 15, W53 "For later" 4): the staff lists' searches match what was typed, anywhere in the text. In
// a LIKE pattern `%` and `_` stand for any text, so a search for "50%" matched "50" followed by anything; here they
// (and the escape character itself) are matched as themselves. Use with `ILIKE $n ESCAPE '\'`.
import 'server-only'

export const likeContaining = (text: string): string => `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
