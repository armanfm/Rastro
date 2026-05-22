// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

contract RastroV3 is ERC721, Ownable {
    using Strings for uint256;

    enum Risco {
        BAIXO,
        MEDIO,
        ALTO,
        PENDENTE
    }

    struct Fazenda {
        string codigoCAR;
        address dono;
        uint8 score;
        Risco risco;
        uint256 atualizadoEm;
        string cid;
        bool existe;
        uint256 tokenId;
    }

    mapping(string => Fazenda) private fazendas;
    mapping(uint256 => string) public tokenIdToCAR;
    mapping(string => uint256) public carToTokenId;
    mapping(string => uint256) private indiceLista; // index + 1

    string[] private listaFazendas;

    uint256 public nextTokenId = 1;
    address public oracle;

    event FazendaCadastrada(
        string codigoCAR,
        address dono,
        uint256 tokenId
    );

    event VerificacaoAtualizada(
        string codigoCAR,
        uint8 score,
        Risco risco,
        string cid,
        uint256 atualizadoEm
    );

    event CARInvalidado(
        string codigoCAR,
        uint256 tokenId,
        uint256 timestamp
    );

    event OracleAlterado(address novoOracle);

    modifier onlyOracle() {
        require(
            msg.sender == oracle || msg.sender == owner(),
            "Nao autorizado"
        );
        _;
    }

    constructor() ERC721("Rastro Compliance", "RASTRO") Ownable(msg.sender) {
        oracle = msg.sender;
    }

    function setOracle(address novoOracle) external onlyOwner {
        oracle = novoOracle;
        emit OracleAlterado(novoOracle);
    }

    // ACEITA:
    // MT-5103858
    // MT-5103858-1DED8526A7E54487BB917F412F965AB5
    function _validarFormatoCAR(
        string calldata car
    ) internal pure returns (bool) {
        bytes memory b = bytes(car);
        uint256 len = b.length;

        if (len < 10) return false;

        // UF
        if (b[0] < 0x41 || b[0] > 0x5A) return false;
        if (b[1] < 0x41 || b[1] > 0x5A) return false;

        // hífen
        if (b[2] != 0x2D) return false;

        // 7 números
        for (uint256 i = 3; i < 10; i++) {
            if (b[i] < 0x30 || b[i] > 0x39) return false;
        }

        // formato curto
        if (len == 10) return true;

        // formato completo precisa hífen
        if (b[10] != 0x2D) return false;
        if (len <= 11) return false;

        // hash final letras maiúsculas e números
        for (uint256 i = 11; i < len; i++) {
            bool isDigit = b[i] >= 0x30 && b[i] <= 0x39;
            bool isUpper = b[i] >= 0x41 && b[i] <= 0x5A;

            if (!isDigit && !isUpper) return false;
        }

        return true;
    }

    function cadastrarCAR(string calldata codigoCAR) external {
        require(
            _validarFormatoCAR(codigoCAR),
            "Formato invalido de CAR"
        );

        require(!fazendas[codigoCAR].existe, "CAR ja cadastrado");

        uint256 tokenId = nextTokenId;
        nextTokenId++;

        _safeMint(msg.sender, tokenId);

        fazendas[codigoCAR] = Fazenda({
            codigoCAR: codigoCAR,
            dono: msg.sender,
            score: 0,
            risco: Risco.PENDENTE,
            atualizadoEm: block.timestamp,
            cid: "",
            existe: true,
            tokenId: tokenId
        });

        listaFazendas.push(codigoCAR);
        indiceLista[codigoCAR] = listaFazendas.length;

        tokenIdToCAR[tokenId] = codigoCAR;
        carToTokenId[codigoCAR] = tokenId;

        emit FazendaCadastrada(
            codigoCAR,
            msg.sender,
            tokenId
        );
    }

    function registrarVerificacao(
        string calldata codigoCAR,
        uint8 score,
        uint8 risco,
        string calldata cid
    ) external onlyOracle {
        require(fazendas[codigoCAR].existe, "CAR nao cadastrado");
        require(score <= 100, "Score invalido");
        require(risco <= uint8(Risco.PENDENTE), "Risco invalido");

        Fazenda storage f = fazendas[codigoCAR];

        f.score = score;
        f.risco = Risco(risco);
        f.cid = cid;
        f.atualizadoEm = block.timestamp;

        emit VerificacaoAtualizada(
            codigoCAR,
            score,
            Risco(risco),
            cid,
            block.timestamp
        );
    }

    function invalidarCAR(
        string calldata codigoCAR
    ) external onlyOracle {
        require(fazendas[codigoCAR].existe, "CAR nao existe");

        Fazenda memory f = fazendas[codigoCAR];
        uint256 tokenId = f.tokenId;

        _burn(tokenId);

        delete tokenIdToCAR[tokenId];
        delete carToTokenId[codigoCAR];
        delete fazendas[codigoCAR];

        uint256 idx = indiceLista[codigoCAR];

        if (idx > 0) {
            uint256 real = idx - 1;
            uint256 ultimo = listaFazendas.length - 1;

            if (real != ultimo) {
                string memory ultimoCAR = listaFazendas[ultimo];
                listaFazendas[real] = ultimoCAR;
                indiceLista[ultimoCAR] = idx;
            }

            listaFazendas.pop();
            delete indiceLista[codigoCAR];
        }

        emit CARInvalidado(
            codigoCAR,
            tokenId,
            block.timestamp
        );
    }

    function getFazenda(
        string calldata codigoCAR
    ) external view returns (Fazenda memory) {
        require(fazendas[codigoCAR].existe, "CAR nao existe");
        return fazendas[codigoCAR];
    }

    function totalFazendas() external view returns (uint256) {
        return listaFazendas.length;
    }

    function listarTodos()
        external
        view
        returns (string[] memory)
    {
        return listaFazendas;
    }

    function tokenURI(
        uint256 tokenId
    ) public view override returns (string memory) {
        require(
            _ownerOf(tokenId) != address(0),
            "Token inexistente"
        );

        string memory car = tokenIdToCAR[tokenId];
        Fazenda memory f = fazendas[car];

        return string(
            abi.encodePacked(
                "data:application/json;utf8,{",
                '"name":"Rastro CAR #',
                tokenId.toString(),
                '",',
                '"description":"Identidade digital de compliance rural",',
                '"attributes":[',
                    '{"trait_type":"CAR","value":"', f.codigoCAR, '"},',
                    '{"trait_type":"Score","value":"', uint256(f.score).toString(), '"},',
                    '{"trait_type":"Risco","value":"', uint256(f.risco).toString(), '"}',
                "]}"
            )
        );
    }
}